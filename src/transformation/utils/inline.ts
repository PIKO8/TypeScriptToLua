import ts, {SignatureDeclaration} from "typescript";
import { TransformationContext } from "../context";
import { InlineFunctionInfo } from "../context";
import * as lua from "../../LuaAST";
import {isMultiFunctionCall} from "../visitors/language-extensions/multi";
import {AnnotationKind, getNodeAnnotations, getSymbolAnnotations} from "./annotations";

interface InlineBodyResult {
  paramAssignments: lua.Statement[];
  bodyStatements: lua.Statement[];
  returnExpressions: lua.Expression[];
  hasMultiReturn: boolean;
}

// AST transformer to substitute parameter identifiers with temp variables
function createParameterSubstitutionTransformer(
  paramReplacements: Map<string, string>
): ts.TransformerFactory<ts.Node> {
  return (context: ts.TransformationContext) => {
    const visit = (node: ts.Node): ts.Node => {
      // Replace identifier if it matches a parameter
      if (ts.isIdentifier(node)) {
        const replacementName = paramReplacements.get(node.text);
        if (replacementName) {
          return ts.factory.createIdentifier(replacementName);
        }
      }

      // Recursively visit children
      return ts.visitEachChild(node, visit, context);
    };

    return visit;
  };
}
export function prepareInlineBody(
  context: TransformationContext,
  inlineInfo: InlineFunctionInfo,
  args: ts.NodeArray<ts.Expression>
): InlineBodyResult {
  if (inlineInfo.isProcessing) {
    throw new Error("Recursive inline call detected (should be caught earlier)");
  }

  inlineInfo.isProcessing = true;
  try {
    const { body, parameters } = inlineInfo;
    const paramReplacements = new Map<string, string>();
    const paramAssignments: lua.Statement[] = [];

    let argIndex = 0;
    for (const param of parameters) {
      if (ts.isIdentifier(param.name) && param.name.text !== "this") {
        const paramName = param.name.text;
        const tempName = context.createTempName(paramName);
        paramReplacements.set(paramName, tempName);

        const arg = argIndex < args.length ? args[argIndex] : undefined;
        const transformedArg = arg ? context.transformExpression(arg) : lua.createNilLiteral();
        paramAssignments.push(
          lua.createVariableDeclarationStatement(
            lua.createIdentifier(tempName),
            transformedArg
          )
        );
        argIndex++;
      }
    }

    // Substitute in body
    const substitutedBody = ts.transform(body, [
      createParameterSubstitutionTransformer(paramReplacements)
    ]).transformed[0] as ts.ConciseBody;

    // Extract body statements and return expressions
    let bodyStatements: lua.Statement[] = [];
    let returnExpressions: lua.Expression[] = [];
    let hasMultiReturn = false;

    if (!ts.isBlock(substitutedBody)) {
      returnExpressions = [context.transformExpression(substitutedBody)];
    } else {
      bodyStatements = context.transformStatements(
        substitutedBody.statements.filter(s => !ts.isReturnStatement(s))
      );
      const returnStmt = substitutedBody.statements.find(ts.isReturnStatement);
      const returnExpr = returnStmt?.expression;
      if (returnExpr) {
        const unwrappedExpr = ts.skipOuterExpressions(returnExpr, ts.OuterExpressionKinds.Assertions);
        if (ts.isCallExpression(unwrappedExpr) && isMultiFunctionCall(context, unwrappedExpr)) {
          hasMultiReturn = true;
          returnExpressions = unwrappedExpr.arguments.map(arg => context.transformExpression(arg));
        } else {
          returnExpressions = [context.transformExpression(returnExpr)];
        }
      }
    }

    return { paramAssignments, bodyStatements, returnExpressions, hasMultiReturn };
  } finally {
    inlineInfo.isProcessing = false;
  }
}

export function embedInlineResult(
  context: TransformationContext,
  paramAndBodyStmts: lua.Statement[],
  returnExprs: lua.Expression[],
  hasMulti: boolean,
  target?: {               // если target задан, то результат присваивается ему
    kind: 'variables';   // может быть массив или одна переменная
    vars: lua.Identifier[];
  },
  isReturnContext?: boolean // true, если вызов был внутри return
): lua.Expression {
  const allStmts = [...paramAndBodyStmts];

  if (isReturnContext) {
    // В контексте return: просто вставляем return в do...end
    allStmts.push(lua.createReturnStatement(hasMulti ? returnExprs : returnExprs));
    context.addPrecedingStatements([lua.createDoStatement(allStmts)]);
    return lua.createNilLiteral(); // сам return уже внутри
  }

  if (target) {
    if (hasMulti) {
      allStmts.push(lua.createAssignmentStatement(target.vars, returnExprs));
    } else {
      allStmts.push(lua.createAssignmentStatement(target.vars[0], returnExprs[0]));
    }
    if (target.vars.length > 1) {
      // Для деструктуризации возвращаем nil, объявление переменных снаружи
      context.addPrecedingStatements([lua.createDoStatement(allStmts)]);
      return lua.createNilLiteral();
    } else {
      // Для одной переменной: возвращаем её, чтобы использовать как expression
      context.addPrecedingStatements([lua.createDoStatement(allStmts)]);
      return target.vars[0];
    }
  }

  // Контекст выражения (не присваивание)
  const tempVar = lua.createIdentifier(context.createTempName("inline_result"));
  allStmts.push(lua.createAssignmentStatement(tempVar, hasMulti ? returnExprs[0] : returnExprs[0]));
  context.addPrecedingStatements([lua.createDoStatement(allStmts)]);
  return tempVar;
}

export function createInlineAssignment(
  paramAndBodyStmts: lua.Statement[],
  returnExprs: lua.Expression[],
  hasMulti: boolean,
  targetVars: lua.Identifier[]
): lua.DoStatement {
  const allStmts = [...paramAndBodyStmts];
  if (hasMulti) {
    allStmts.push(lua.createAssignmentStatement(targetVars, returnExprs));
  } else {
    allStmts.push(lua.createAssignmentStatement(targetVars[0], returnExprs[0]));
  }
  return lua.createDoStatement(allStmts);
}

export function isInlineFunctionCandidate(
  context: TransformationContext,
  node: SignatureDeclaration
): boolean {
  // Check for @inline annotation
  const symbol = node.name ? context.checker.getSymbolAtLocation(node.name) : undefined;
  if (symbol) {
    const annotations = getSymbolAnnotations(symbol);
    if (annotations.has(AnnotationKind.Inline)) {
      return true;
    }
  }

  // Also check node annotations (for cases where symbol might not be available)
  const nodeAnnotations = getNodeAnnotations(node);
  return nodeAnnotations.has(AnnotationKind.Inline);
}