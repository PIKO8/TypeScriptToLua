import ts, {SignatureDeclaration} from "typescript";
import { TransformationContext } from "../context";
import { InlineFunctionInfo } from "../context";
import * as lua from "../../LuaAST";
import {isMultiFunctionCall} from "../visitors/language-extensions/multi";
import {AnnotationKind, getNodeAnnotations, getSymbolAnnotations} from "./annotations";
import {internalUnknownError} from "./diagnostics";

interface InlineBodyResult {
  paramAssignments: lua.Statement[];
  bodyStatements: lua.Statement[];
  returnExpressions: lua.Expression[];
  hasMultiReturn: boolean;
}
type FunctionLikeExpression = ts.ArrowFunction | ts.FunctionExpression
function isFunctionLikeExpression(node: ts.Expression): node is FunctionLikeExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

interface InlineLambdaInfo {
  node: FunctionLikeExpression
}

interface InlineLambdaBlockInfo {
  node: FunctionLikeExpression
  args: ts.NodeArray<ts.Expression>
}

// AST transformer to substitute parameter identifiers with temp variables
function createParameterSubstitutionTransformer(
  otherCtx: TransformationContext,
  paramReplacements: Map<string, ts.Expression>,
  lambdaParamMap: Map<string, InlineLambdaInfo>,
  blockLambdaReplacements: Map<string, InlineLambdaBlockInfo>
): ts.TransformerFactory<ts.Node> {
  return (ctx: ts.TransformationContext) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isIdentifier(node) && paramReplacements.has(node.text)) {
        return paramReplacements.get(node.text)!
      }

      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && lambdaParamMap.has(callee.text)) {
          const info = lambdaParamMap.get(callee.text)!
          if (info.node.body.kind === ts.SyntaxKind.Block) {
            /// Block‑lambda: create a temp variable and store it in the map
            const tempResult = otherCtx.createTempName("lambdaResult")
            blockLambdaReplacements.set(tempResult, { node: info.node, args: node.arguments })
            return ts.factory.createIdentifier(tempResult)
          }
          // Expression‑lambda: we substitute the body
          return substituteLambdaCall(otherCtx, info, node);
        }
      }
      return ts.visitEachChild(node, visit, ctx);
    };
    return visit;
  };
}

function expandStatement(
  stmt: ts.Statement,
  replacements: Map<string, InlineLambdaBlockInfo>
): ts.Statement[] {
  const tempNamesSet = new Set(replacements.keys());

  if (ts.isIfStatement(stmt)) {
    const thenBlock = ts.isBlock(stmt.thenStatement)
      ? expandBlock(stmt.thenStatement, replacements)
      : stmt.thenStatement;
    const elseBlock = stmt.elseStatement && ts.isBlock(stmt.elseStatement)
      ? expandBlock(stmt.elseStatement, replacements)
      : stmt.elseStatement;

    // Проверяем только условие if, тело уже обработано рекурсивно
    const usedTemps = getUsedTempIdentifiers(stmt.expression, tempNamesSet);
    const newStmt = ts.factory.createIfStatement(stmt.expression, thenBlock, elseBlock);

    if (usedTemps.length === 0) return [newStmt];
    const newStmts = buildLambdasDeclarations(usedTemps, replacements);
    newStmts.push(newStmt);
    return newStmts;
  }

  if (ts.isForStatement(stmt)) {
    const newBody = expandBlock(stmt.statement as ts.Block, replacements);

    // Проверяем только заголовочные части: initializer, condition, incrementor
    const usedTemps = [
      ...getUsedTempIdentifiers(stmt.initializer ?? ts.factory.createNull(), tempNamesSet),
      ...getUsedTempIdentifiers(stmt.condition ?? ts.factory.createNull(), tempNamesSet),
      ...getUsedTempIdentifiers(stmt.incrementor ?? ts.factory.createNull(), tempNamesSet),
    ];

    const newStmt = ts.factory.createForStatement(stmt.initializer, stmt.condition, stmt.incrementor, newBody);

    if (usedTemps.length === 0) return [newStmt];
    const newStmts = buildLambdasDeclarations(usedTemps, replacements);
    newStmts.push(newStmt);
    return newStmts;
  }

  if (ts.isForOfStatement(stmt)) {
    const newBody = expandBlock(stmt.statement as ts.Block, replacements);

    // Проверяем только expression и initializer
    const usedTemps = [
      ...getUsedTempIdentifiers(stmt.initializer, tempNamesSet),
      ...getUsedTempIdentifiers(stmt.expression, tempNamesSet),
    ];

    const newStmt = ts.factory.createForOfStatement(stmt.awaitModifier, stmt.initializer, stmt.expression, newBody);

    if (usedTemps.length === 0) return [newStmt];
    const newStmts = buildLambdasDeclarations(usedTemps, replacements);
    newStmts.push(newStmt);
    return newStmts;
  }

  if (ts.isWhileStatement(stmt)) {
    const newBody = expandBlock(stmt.statement as ts.Block, replacements);

    // Проверяем только условие while
    const usedTemps = getUsedTempIdentifiers(stmt.expression, tempNamesSet);
    const newStmt = ts.factory.createWhileStatement(stmt.expression, newBody);

    if (usedTemps.length === 0) return [newStmt];
    const newStmts = buildLambdasDeclarations(usedTemps, replacements);
    newStmts.push(newStmt);
    return newStmts;
  }

  if (ts.isBlock(stmt)) {
    return [expandBlock(stmt, replacements)];
  }

  // Простой стейтмент — проверяем полностью
  const usedTemps = getUsedTempIdentifiers(stmt, tempNamesSet);
  if (usedTemps.length === 0) return [stmt];
  const newStmts = buildLambdasDeclarations(usedTemps, replacements);
  newStmts.push(stmt);
  return newStmts;
}

function buildLambdasDeclarations(
  tempNames: string[],
  replacements: Map<string, InlineLambdaBlockInfo>
): ts.Statement[] {
  const stmts: ts.Statement[] = [];
  for (const tempName of tempNames) {
    const { node, args } = replacements.get(tempName)!;
    const tempId = ts.factory.createIdentifier(tempName);
    // объявление переменной
    stmts.push(
      ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList(
          [ts.factory.createVariableDeclaration(tempId, undefined, undefined, ts.factory.createNull())],
          ts.NodeFlags.Const
        )
      )
    );
    // do‑блок с телом лямбды
    stmts.push(buildDoBlockForLambda(node, args, tempId));
  }
  return stmts;
}

function expandBlock(block: ts.Block, replacements: Map<string, InlineLambdaBlockInfo>): ts.Block {
  const newStatements: ts.Statement[] = [];
  for (const stmt of block.statements) {
    newStatements.push(...expandStatement(stmt, replacements));
  }
  return ts.factory.createBlock(newStatements);
}

function getUsedTempIdentifiers(node: ts.Node, tempNames: Set<string>): string[] {
  const found: string[] = [];
  function visit(n: ts.Node) {
    if (ts.isIdentifier(n) && tempNames.has(n.text)) {
      if (!found.includes(n.text)) found.push(n.text);
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

function buildDoBlockForLambda(
  funcNode: FunctionLikeExpression,
  callArgs: ts.NodeArray<ts.Expression>,
  resultVar: ts.Identifier
): ts.Block {
  const lambdaParams = funcNode.parameters;
  const paramMap = new Map<string, ts.Expression>();
  let argIdx = 0;
  for (const p of lambdaParams) {
    if (ts.isIdentifier(p.name) && p.name.text !== "this") {
      const arg = argIdx < callArgs.length ? callArgs[argIdx] : ts.factory.createNull();
      paramMap.set(p.name.text, arg);
      argIdx++;
    }
  }

  const innerTransformer = (ctx: ts.TransformationContext) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isIdentifier(node) && paramMap.has(node.text)) {
        return paramMap.get(node.text)!;
      }
      return ts.visitEachChild(node, visit, ctx);
    };
    return visit;
  };
  const transformed = ts.transform(funcNode.body, [innerTransformer]);
  const substBody = transformed.transformed[0] as ts.Block;
  transformed.dispose();

  // Формируем операторы тела (кроме return) + присваивание
  const doStmts: ts.Statement[] = [];
  const retStmt = substBody.statements.find(ts.isReturnStatement);
  const retExpr = retStmt?.expression ?? ts.factory.createNull();

  doStmts.push(...substBody.statements.filter(s => !ts.isReturnStatement(s)));
  doStmts.push(
    ts.factory.createExpressionStatement(
      ts.factory.createAssignment(resultVar, retExpr)
    )
  );

  // Обернём в блок, который станет do...end в Lua
  return ts.factory.createBlock(doStmts, true);
}

function substituteLambdaCall(
  context: TransformationContext,
  info: InlineLambdaInfo,
  callNode: ts.CallExpression
): ts.Expression {
  const funcNode = info.node
  const lambdaParams = funcNode.parameters;
  const callArgs = callNode.arguments;
  const paramMap = new Map<string, ts.Expression>();

  let argIndex = 0;
  for (const p of lambdaParams) {
    if (ts.isIdentifier(p.name) && p.name.text !== "this") {
      const arg = argIndex < callArgs.length ? callArgs[argIndex] : ts.factory.createNull();
      paramMap.set(p.name.text, arg);
      argIndex++;
    }
  }

  const body = funcNode.body;
  // Трансформер для подстановки
  const innerTransformer = (ctx: ts.TransformationContext) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isIdentifier(node) && paramMap.has(node.text)) {
        return paramMap.get(node.text)!;
      }
      return ts.visitEachChild(node, visit, ctx);
    };
    return visit;
  };
  const innerResult = ts.transform(body, [innerTransformer]);
  const substitutedBody = innerResult.transformed[0] as ts.ConciseBody;
  innerResult.dispose();

  if (ts.isBlock(substitutedBody)) {
    context.diagnostics.push(internalUnknownError(substitutedBody))
    return ts.factory.createNull()
  } else {
    return substitutedBody;
  }
}

export function prepareInlineBody(
  context: TransformationContext,
  inlineInfo: InlineFunctionInfo,
  args: ts.NodeArray<ts.Expression>
): InlineBodyResult {
  const { body, parameters } = inlineInfo;

  const paramReplacements = new Map<string, ts.Expression>();
  const paramAssignments: lua.Statement[] = [];
  const lambdaParamMap = new Map<string, InlineLambdaInfo>();
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

      // Check if argument is a lambda/arrow
      if (arg && isFunctionLikeExpression(arg)) {
        // Ensure the parameter is actually called in the body (we'll check later)
        lambdaParamMap.set(param.name.text, { node: arg })
        argIndex++
        continue
      }
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

  const blockLambdaReplacements = new Map<string, InlineLambdaBlockInfo>()

  // Substitute in body
  let substitutedBody = ts.transform(body, [
    createParameterSubstitutionTransformer(context, paramReplacements, lambdaParamMap, blockLambdaReplacements)
  ]).transformed[0] as ts.ConciseBody;

  substitutedBody = ts.isBlock(substitutedBody)
    ? expandBlock(substitutedBody, blockLambdaReplacements)
    : substitutedBody;

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