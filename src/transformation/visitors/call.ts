import * as ts from "typescript";
import * as lua from "../../LuaAST";
import { transformBuiltinCallExpression } from "../builtins";
import { FunctionVisitor, TransformationContext } from "../context";
import { validateAssignment } from "../utils/assignment-validation";
import { ContextType, getCallContextType } from "../utils/function-context";
import { wrapInTable } from "../utils/lua-ast";
import { isValidLuaIdentifier } from "../utils/safe-names";
import { isExpressionWithEvaluationEffect } from "../utils/typescript";
import { transformElementAccessArgument } from "./access";
import { isMultiReturnCall, shouldMultiReturnCallBeWrapped } from "./language-extensions/multi";
import { unsupportedBuiltinOptionalCall } from "../utils/diagnostics";
import { moveToPrecedingTemp, transformExpressionList } from "./expression-list";
import { transformInPrecedingStatementScope } from "../utils/preceding-statements";
import { getOptionalContinuationData, transformOptionalChain } from "./optional-chaining";
import { transformImportExpression } from "./modules/import";
import { transformLanguageExtensionCallExpression } from "./language-extensions/call-extension";
import { getCustomNameFromSymbol } from "./identifier";
import { embedInlineResult, InlineContextExtend, prepareInlineBody } from "../utils/inline";

export function validateArguments(
    context: TransformationContext,
    params: readonly ts.Expression[],
    signature?: ts.Signature
) {
    if (!signature || signature.parameters.length < params.length) {
        return;
    }
    for (const [index, param] of params.entries()) {
        const signatureParameter = signature.parameters[index];
        if (signatureParameter.valueDeclaration !== undefined) {
            const signatureType = context.checker.getTypeAtLocation(signatureParameter.valueDeclaration);
            const paramType = context.checker.getTypeAtLocation(param);
            validateAssignment(context, param, paramType, signatureType, signatureParameter.name);
        }
    }
}

export function transformArguments(
    context: TransformationContext,
    params: readonly ts.Expression[],
    signature?: ts.Signature,
    callContext?: ts.Expression
): lua.Expression[] {
    validateArguments(context, params, signature);
    return transformExpressionList(context, callContext ? [callContext, ...params] : params);
}

function transformCallWithArguments(
    context: TransformationContext,
    callExpression: ts.Expression,
    transformedArguments: lua.Expression[],
    argPrecedingStatements: lua.Statement[],
    callContext?: ts.Expression
): [lua.Expression, lua.Expression[]] {
    let call = context.transformExpression(callExpression);

    let transformedContext: lua.Expression | undefined;
    if (callContext) {
        transformedContext = context.transformExpression(callContext);
    }

    if (argPrecedingStatements.length > 0) {
        if (transformedContext) {
            transformedContext = moveToPrecedingTemp(context, transformedContext, callContext);
        }
        call = moveToPrecedingTemp(context, call, callExpression);
        context.addPrecedingStatements(argPrecedingStatements);
    }

    if (transformedContext) {
        transformedArguments.unshift(transformedContext);
    }

    return [call, transformedArguments];
}

export function transformCallAndArguments(
    context: TransformationContext,
    callExpression: ts.Expression,
    params: readonly ts.Expression[],
    signature?: ts.Signature,
    callContext?: ts.Expression
): [lua.Expression, lua.Expression[]] {
    const { precedingStatements: argPrecedingStatements, result: transformedArguments } =
        transformInPrecedingStatementScope(context, () => transformArguments(context, params, signature, callContext));
    return transformCallWithArguments(context, callExpression, transformedArguments, argPrecedingStatements);
}

function transformElementAccessCall(
    context: TransformationContext,
    left: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    transformedArguments: lua.Expression[],
    argPrecedingStatements: lua.Statement[]
) {
    // Cache left-side if it has effects
    // local ____self = context; return ____self[argument](parameters);
    const selfIdentifier = lua.createIdentifier(context.createTempName("self"));
    const callContext = context.transformExpression(left.expression);
    const selfAssignment = lua.createVariableDeclarationStatement(selfIdentifier, callContext);
    context.addPrecedingStatements(selfAssignment);

    const argument = ts.isElementAccessExpression(left)
        ? transformElementAccessArgument(context, left)
        : lua.createStringLiteral(left.name.text);

    let index: lua.Expression = lua.createTableIndexExpression(selfIdentifier, argument);

    if (argPrecedingStatements.length > 0) {
        // Cache index in temp if args had preceding statements
        index = moveToPrecedingTemp(context, index);
        context.addPrecedingStatements(argPrecedingStatements);
    }

    return lua.createCallExpression(index, [selfIdentifier, ...transformedArguments]);
}

export function transformContextualCallExpression(
    context: TransformationContext,
    node: ts.CallExpression | ts.TaggedTemplateExpression,
    args: ts.Expression[] | ts.NodeArray<ts.Expression>
): lua.Expression {
    if (ts.isOptionalChain(node)) {
        return transformOptionalChain(context, node);
    }
    const left = ts.isCallExpression(node) ? getCalledExpression(node) : node.tag;

    let { precedingStatements: argPrecedingStatements, result: transformedArguments } =
        transformInPrecedingStatementScope(context, () => transformArguments(context, args));

    if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.name) &&
        isValidLuaIdentifier(left.name.text, context.options) &&
        argPrecedingStatements.length === 0
    ) {
        // table:name()
        const table = context.transformExpression(left.expression);
        let name = left.name.text;

        const symbol = context.checker.getSymbolAtLocation(left);
        const customName = getCustomNameFromSymbol(context, symbol);

        if (customName) {
            name = customName;
        }

        return lua.createMethodCallExpression(table, lua.createIdentifier(name, left.name), transformedArguments, node);
    } else if (ts.isElementAccessExpression(left) || ts.isPropertyAccessExpression(left)) {
        if (isExpressionWithEvaluationEffect(left.expression)) {
            return transformElementAccessCall(context, left, transformedArguments, argPrecedingStatements);
        } else {
            let expression: lua.Expression;
            [expression, transformedArguments] = transformCallWithArguments(
                context,
                left,
                transformedArguments,
                argPrecedingStatements,
                left.expression
            );
            return lua.createCallExpression(expression, transformedArguments, node);
        }
    } else if (ts.isIdentifier(left) || ts.isCallExpression(left)) {
        const callContext = context.isStrict ? ts.factory.createNull() : ts.factory.createIdentifier("_G");
        let expression: lua.Expression;
        [expression, transformedArguments] = transformCallWithArguments(
            context,
            left,
            transformedArguments,
            argPrecedingStatements,
            callContext
        );
        return lua.createCallExpression(expression, transformedArguments, node);
    } else {
        throw new Error(`Unsupported LeftHandSideExpression kind: ${ts.SyntaxKind[left.kind]}`);
    }
}

function transformPropertyCall(
    context: TransformationContext,
    node: ts.CallExpression,
    calledMethod: ts.PropertyAccessExpression
): lua.Expression {
    const signature = context.checker.getResolvedSignature(node);

    if (calledMethod.expression.kind === ts.SyntaxKind.SuperKeyword) {
        // Super calls take the format of super.call(self,...)
        const parameters = transformArguments(context, node.arguments, signature, ts.factory.createThis());
        return lua.createCallExpression(context.transformExpression(node.expression), parameters, node);
    }

    if (getCallContextType(context, node) !== ContextType.Void) {
        // table:name()
        return transformContextualCallExpression(context, node, node.arguments);
    } else {
        // table.name()
        const [callPath, parameters] = transformCallAndArguments(context, node.expression, node.arguments, signature);

        return lua.createCallExpression(callPath, parameters, node);
    }
}

function transformElementCall(context: TransformationContext, node: ts.CallExpression): lua.Expression {
    if (getCallContextType(context, node) !== ContextType.Void) {
        // A contextual parameter must be given to this call expression
        return transformContextualCallExpression(context, node, node.arguments);
    } else {
        // No context
        const [expression, parameters] = transformCallAndArguments(context, node.expression, node.arguments);
        return lua.createCallExpression(expression, parameters, node);
    }
}

export const transformCallExpression: FunctionVisitor<ts.CallExpression> = (node, context) => {
    const calledExpression = getCalledExpression(node);

    // Check for inline function calls first
    const inlineResult = tryTransformInlineCall(context, node);
    if (inlineResult) {
        return inlineResult;
    }

    if (calledExpression.kind === ts.SyntaxKind.ImportKeyword) {
        return transformImportExpression(node, context);
    }

    if (ts.isOptionalChain(node)) {
        return transformOptionalChain(context, node);
    }

    const optionalContinuation = ts.isIdentifier(calledExpression)
        ? getOptionalContinuationData(calledExpression)
        : undefined;
    const wrapResultInTable = isMultiReturnCall(context, node) && shouldMultiReturnCallBeWrapped(context, node);

    const builtinOrExtensionResult =
        transformBuiltinCallExpression(context, node) ?? transformLanguageExtensionCallExpression(context, node);
    if (builtinOrExtensionResult) {
        if (optionalContinuation !== undefined) {
            context.diagnostics.push(unsupportedBuiltinOptionalCall(node));
        }
        return wrapResultInTable ? wrapInTable(builtinOrExtensionResult) : builtinOrExtensionResult;
    }

    if (ts.isPropertyAccessExpression(calledExpression)) {
        const result = transformPropertyCall(context, node, calledExpression);
        return wrapResultInTable ? wrapInTable(result) : result;
    }

    if (ts.isElementAccessExpression(calledExpression)) {
        const result = transformElementCall(context, node);
        return wrapResultInTable ? wrapInTable(result) : result;
    }

    const signature = context.checker.getResolvedSignature(node);

    // Handle super calls properly
    if (calledExpression.kind === ts.SyntaxKind.SuperKeyword) {
        const parameters = transformArguments(context, node.arguments, signature, ts.factory.createThis());

        return lua.createCallExpression(
            lua.createTableIndexExpression(
                context.transformExpression(ts.factory.createSuper()),
                lua.createStringLiteral("____constructor")
            ),
            parameters,
            node
        );
    }

    let callPath: lua.Expression;
    let parameters: lua.Expression[];

    const isContextualCall = getCallContextType(context, node) !== ContextType.Void;

    if (!isContextualCall) {
        [callPath, parameters] = transformCallAndArguments(context, calledExpression, node.arguments, signature);
    } else {
        // if is optionalContinuation, context will be handled by transformOptionalChain.
        const useGlobalContext = !context.isStrict && optionalContinuation === undefined;
        const callContext = useGlobalContext ? ts.factory.createIdentifier("_G") : ts.factory.createNull();
        [callPath, parameters] = transformCallAndArguments(
            context,
            calledExpression,
            node.arguments,
            signature,
            callContext
        );
    }

    const callExpression = lua.createCallExpression(callPath, parameters, node);
    if (optionalContinuation && isContextualCall) {
        optionalContinuation.contextualCall = callExpression;
    }
    return wrapResultInTable ? wrapInTable(callExpression) : callExpression;
};

export function getCalledExpression(node: ts.CallExpression): ts.Expression {
    return ts.skipOuterExpressions(node.expression);
}

function getCallContext(node: ts.CallExpression): {
    kind: "return" | "variable-declaration" | "destructuring" | "expression";
    variableName?: string;
    destructuredNames?: string[];
} {
    const parent = node.parent;

    // Case 1: return method()
    if (ts.isReturnStatement(parent) && parent.expression === node) {
        return { kind: "return" };
    }

    // Case 2: const [a, b] = method() - destructuring
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isArrayBindingPattern(parent.name)) {
        const names = parent.name.elements
            .map(elem => {
                // OmittedExpression не имеет name (например: const [a, , c] = ...)
                if (ts.isOmittedExpression(elem)) {
                    return undefined;
                }
                // BindingElement имеет name
                if (ts.isIdentifier(elem.name)) {
                    return elem.name.text;
                }
                return undefined;
            })
            .filter((name): name is string => name !== undefined);
        return { kind: "destructuring", destructuredNames: names };
    }

    // Case 3: const res = method() - variable declaration
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
        return { kind: "variable-declaration", variableName: parent.name.text };
    }

    // Case 4: Other contexts (expressions, arguments, etc.)
    return { kind: "expression" };
}

function tryTransformInlineCall(context: TransformationContext, node: ts.CallExpression): lua.Expression | undefined {
    const calledExpression = getCalledExpression(node);

    // Get the symbol of the called expression
    let symbol: ts.Symbol | undefined;
    if (ts.isIdentifier(calledExpression)) {
        symbol = context.checker.getSymbolAtLocation(calledExpression);
    } else if (ts.isPropertyAccessExpression(calledExpression) || ts.isElementAccessExpression(calledExpression)) {
        symbol = context.checker.getSymbolAtLocation(calledExpression);
    }

    if (!symbol) return undefined;

    // Resolve aliased symbols (imports) to their original declaration
    if (symbol.flags & ts.SymbolFlags.Alias) {
        symbol = context.checker.getAliasedSymbol(symbol);
    }

    // Check if this is an inline function
    const inlineInfo = context.inlineFunctions.get(symbol);
    if (!inlineInfo) return undefined;

    const result = prepareInlineBody(context, inlineInfo, node.arguments);

    const callCtx = getCallContext(node);

    const isNested = (context as any as InlineContextExtend).__inlineDepth > 0;
    const isResultContext = !isNested && callCtx.kind === "return";

    // console.log(`Inline function ${symbol.name} called, Result = {hasMultiReturn=${result.hasMultiReturn},returnExpressions=${result.returnExpressions.length},paramAssignments=${result.paramAssignments.length},hasMultiReturn=${result.hasMultiReturn},target=${callCtx.kind},isReturn=${callCtx.kind==='return'}}`)
    let target: { kind: "variables"; vars: lua.Identifier[] } | undefined;
    if (callCtx.kind === "variable-declaration") {
        target = { kind: "variables", vars: [lua.createIdentifier(callCtx.variableName!)] };
    } else if (callCtx.kind === "destructuring") {
        target = { kind: "variables", vars: callCtx.destructuredNames!.map(n => lua.createIdentifier(n)) };
    }

    return embedInlineResult(
        context,
        symbol.name,
        [...result.paramAssignments, ...result.bodyStatements],
        result.returnExpressions,
        result.hasMultiReturn,
        target,
        isResultContext
    );
}
