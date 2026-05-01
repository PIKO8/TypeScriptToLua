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
  paramReplacements: Map<string, ts.Expression>
): ts.TransformerFactory<ts.Node> {
  return (ctx: ts.TransformationContext) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isIdentifier(node) && paramReplacements.has(node.text)) {
        return paramReplacements.get(node.text)!
      }
      return ts.visitEachChild(node, visit, ctx);
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

    const paramReplacements = new Map<string, ts.Expression>();
    const paramAssignments: lua.Statement[] = [];
    const paramNames = new Set<string>();
    for (const param of parameters) {
      if (ts.isIdentifier(param.name) && param.name.text !== "this") {
        paramNames.add(param.name.text);
      }
    }

    const usageCounts = countParamUsages(body, paramNames);

    let argIndex = 0;
    for (const param of parameters) {
      if (ts.isIdentifier(param.name) && param.name.text !== "this") {
        const paramName = param.name.text;
        const arg = argIndex < args.length ? args[argIndex] : undefined;
        const tsArg = arg ?? ts.factory.createNull();

        const usage = usageCounts.get(paramName) ?? 0;
        if (usage === 1) {
          // Прямая подстановка аргумента
          paramReplacements.set(paramName, tsArg);
          // temp не создаётся
        } else {
          const tempName = context.createTempName(paramName);
          paramReplacements.set(paramName, ts.factory.createIdentifier(tempName));
          const transformedArg = arg ? context.transformExpression(arg) : lua.createNilLiteral();
          paramAssignments.push(
            lua.createVariableDeclarationStatement(lua.createIdentifier(tempName), transformedArg)
          );
        }
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

function countParamUsages(body: ts.ConciseBody, paramNames: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of paramNames) counts.set(name, 0);

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && counts.has(node.text)) {
      counts.set(node.text, counts.get(node.text)! + 1);
    }
    ts.forEachChild(node, visit);
  }

  visit(body);
  return counts;
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
  // Оптимизация: если нет промежуточных стейтментов, можно обойтись без do...end
  if (paramAndBodyStmts.length === 0) {
    if (isReturnContext) {
      // Для return вставляем return-стейтмент напрямую, без do...end
      context.addPrecedingStatements([
        lua.createReturnStatement(hasMulti ? returnExprs : returnExprs)
      ]);
      return lua.createNilLiteral();
    }

    if (target) {
      if (target.vars.length > 1) {
        // Деструктуризация (обычно обрабатывается в variable-declaration, но на всякий случай)
        context.addPrecedingStatements([
          lua.createAssignmentStatement(target.vars, hasMulti ? returnExprs : [returnExprs[0]])
        ]);
        return lua.createNilLiteral();
      } else {
        // Одна переменная — возвращаем значение для присваивания (используется call.ts)
        // Не добавляем preceding statements, возвращаем само выражение
        return hasMulti ? returnExprs[0] : returnExprs[0];
      }
    }

    // Expression-контекст: просто возвращаем первое выражение
    return returnExprs[0];
  }

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