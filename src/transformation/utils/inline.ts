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

// @ts-ignore
function linkParents(node: ts.Node, parent?: ts.Node): ts.Node {
  if (parent !== undefined && node.parent === undefined) {
    (node as any).parent = parent;
  }
  ts.forEachChild(node, child => linkParents(child, node));
  return node;
}

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
          // Явно трансформируем аргументы перед использованием
          const transformedArgs = ts.factory
            .createNodeArray(
              ts.visitNodes(node.arguments, visit)
                .filter(ts.isExpression)
            );

          const info = lambdaParamMap.get(callee.text)!;
          if (info.node.body.kind === ts.SyntaxKind.Block) {
            const tempResult = otherCtx.createTempName("lambdaResult");
            blockLambdaReplacements.set(tempResult, { node: info.node, args: transformedArgs });
            return ts.setTextRange(ts.factory.createIdentifier(tempResult), callee);
          }
          return substituteLambdaCall(otherCtx, info, { ...node, arguments: transformedArgs } satisfies ts.CallExpression);
        }
        return ts.visitEachChild(node, visit, ctx);
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
  return linkParents(ts.factory.createBlock(newStatements), block.parent) as ts.Block;
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

function countAllReturns(node: ts.Node): number {
  let count = 0;
  const visit = (n: ts.Node) => {
    if (ts.isReturnStatement(n)) count++;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return count;
}

function buildDoBlockForLambda(
  funcNode: FunctionLikeExpression,
  callArgs: ts.NodeArray<ts.Expression>,
  resultVar: ts.Identifier
): ts.Block {
  const paramMap = new Map<string, ts.Expression>();
  let argIdx = 0;
  for (const p of funcNode.parameters) {
    if (ts.isIdentifier(p.name) && p.name.text !== "this") {
      const arg = argIdx < callArgs.length ? callArgs[argIdx] : ts.factory.createNull();
      paramMap.set(p.name.text, arg);
      argIdx++;
    }
  }

  const doneFlag = ts.factory.createIdentifier(`____done_${resultVar.text}`);

  const paramSubstituter = (ctx: ts.TransformationContext) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isIdentifier(node) && paramMap.has(node.text)) {
        return paramMap.get(node.text)!;
      }
      return ts.visitEachChild(node, visit, ctx);
    };
    return visit;
  };

  const withParams = ts.transform(funcNode.body, [paramSubstituter]).transformed[0] as ts.Block;

  const totalReturns = countAllReturns(withParams);
  const lastStmt = withParams.statements[withParams.statements.length - 1];
  const isSimpleReturn = totalReturns === 1 && ts.isReturnStatement(lastStmt);

  if (isSimpleReturn) {
    const nonReturnStmts = withParams.statements.filter(s => !ts.isReturnStatement(s));
    const returnExpr = lastStmt.expression ?? ts.factory.createNull();
    const finalStmts = [
      ...nonReturnStmts,
      ts.factory.createExpressionStatement(ts.factory.createAssignment(resultVar, returnExpr))
    ];
    return ts.setTextRange(ts.factory.createBlock(finalStmts, true), funcNode.body);
  }

  const returnGuardTransformer = (ctx: ts.TransformationContext) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isReturnStatement(node)) {
        const assignment = ts.factory.createExpressionStatement(
          ts.factory.createAssignment(resultVar, node.expression ?? ts.factory.createNull())
        );
        const setDone = ts.factory.createExpressionStatement(
          ts.factory.createAssignment(doneFlag, ts.factory.createTrue())
        );
        return ts.factory.createIfStatement(
          ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, doneFlag),
          ts.factory.createBlock([assignment, setDone])
        );
      }
      if (ts.isIfStatement(node)) {
        let thenStmt: undefined | ts.Statement = undefined;
        if (ts.isBlock(node.thenStatement)) {
          const outStmts = ts.visitNodes(node.thenStatement.statements, visit)
            .map(n => ts.isExpression(n) ? ts.factory.createExpressionStatement(n) : n)
            .filter(ts.isStatement);

          if (outStmts.length > 0) {
            if (outStmts.length === 1) {
              thenStmt = outStmts[0]
            } else {
              thenStmt = ts.factory.createBlock(outStmts, true)
            }
          }
        } else {
          const outNode = ts.visitNode(node.thenStatement, visit);
          if (ts.isStatement(outNode)) {
            thenStmt = outNode;
          } else if (ts.isExpression(outNode)) {
            thenStmt = ts.factory.createExpressionStatement(outNode);
          }
        }
        let elseStmt: ts.Statement | undefined = undefined;
        if (node.elseStatement) {
          if (ts.isBlock(node.elseStatement)) {
            const outStmts = ts.visitNodes(node.elseStatement.statements, visit)
              .map(n => ts.isExpression(n) ? ts.factory.createExpressionStatement(n) : n)
              .filter(ts.isStatement);

            if (outStmts.length > 0) {
              if (outStmts.length === 1) {
                elseStmt = outStmts[0]
              } else {
                elseStmt = ts.factory.createBlock(outStmts, true)
              }
            }
          } else {
            const outNode = ts.visitNode(node.elseStatement, visit);
            if (ts.isStatement(outNode)) {
              elseStmt = outNode;
            } else if (ts.isExpression(outNode)) {
              elseStmt = ts.factory.createExpressionStatement(outNode);
            }
          }
        }
        // return ts.factory.createIfStatement(node.expression, thenStmt, elseStmt);
        if (thenStmt) {
          return ts.factory.createIfStatement(node.expression, thenStmt, elseStmt);
        } else if (elseStmt) {
          return ts.factory.createIfStatement(ts.factory.createLogicalNot(node.expression), elseStmt);
        }
      }
      return ts.visitEachChild(node, visit, ctx);
    };
    return visit;
  };

  const guardedBody = ts.transform(withParams, [returnGuardTransformer]).transformed[0] as ts.Block;

  const doneFlagDecl = ts.setTextRange(
    ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList([
        ts.factory.createVariableDeclaration(doneFlag, undefined, undefined, ts.factory.createFalse())
      ], ts.NodeFlags.Const)
    ),
    funcNode.body
  );

  const finalStatements = [
    doneFlagDecl,
    ...guardedBody.statements
  ];

  return ts.setTextRange(
    ts.factory.createBlock(finalStatements, true),
    funcNode.body
  );
}

function substituteLambdaCall(
  context: TransformationContext,
  info: InlineLambdaInfo,
  callNode: ts.CallExpression
): ts.Expression {
  const funcNode = info.node;
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

  // Этап 1: подстановка параметров
  const paramSubstituter = (ctx: ts.TransformationContext) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isIdentifier(node) && paramMap.has(node.text)) {
        return paramMap.get(node.text)!;
      }
      return ts.visitEachChild(node, visit, ctx);
    };
    return visit;
  };

  const withParams = ts.transform(funcNode.body, [paramSubstituter]).transformed[0] as ts.ConciseBody;

  if (ts.isBlock(withParams)) {
    context.diagnostics.push(internalUnknownError(withParams));
    return ts.factory.createNull();
  }

  return withParams;
}

export function prepareInlineBody(
  context: TransformationContext,
  inlineInfo: InlineFunctionInfo,
  args: ts.NodeArray<ts.Expression>
): InlineBodyResult {
  try {
    const {body, parameters} = inlineInfo;

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

        if (arg && isFunctionLikeExpression(arg)) {
          lambdaParamMap.set(param.name.text, {node: arg});
          argIndex++;
          continue;
        }
        if (usage === 1) {
          paramReplacements.set(paramName, tsArg);
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

    const blockLambdaReplacements = new Map<string, InlineLambdaBlockInfo>();

    let substitutedBody = ts.transform(body, [
      createParameterSubstitutionTransformer(context, paramReplacements, lambdaParamMap, blockLambdaReplacements)
    ]).transformed[0] as ts.ConciseBody;

    substitutedBody = ts.isBlock(substitutedBody)
      ? expandBlock(substitutedBody, blockLambdaReplacements)
      : substitutedBody;

    if (substitutedBody) {
      linkParents(substitutedBody, inlineInfo.body.parent);
    }

    if (!substitutedBody) {
      return {paramAssignments, bodyStatements: [], returnExpressions: [], hasMultiReturn: false};
    }

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

    return {paramAssignments, bodyStatements, returnExpressions, hasMultiReturn};
  } catch (e) {
    throw new WrappedError(`Inline error, node: ${inlineInfo.node?.name?.text}, args: ${args.map(a => a.getText()).join(', ')}`, { cause: e })
  }
}

class WrappedError extends Error {
  // @ts-ignore
  private cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'WrappedError';
    this.cause = options?.cause;

    Object.setPrototypeOf(this, WrappedError.prototype);
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
  funcName: string,
  paramAndBodyStmts: lua.Statement[],
  returnExprs: lua.Expression[],
  hasMulti: boolean,
  target?: {
    kind: 'variables';
    vars: lua.Identifier[];
  },
  isReturnContext?: boolean
): lua.Expression {
  if (isReturnContext && target) {
    // Конфликт контекстов: приоритет у присваивания, а не возврата
    isReturnContext = false;
  }

  // Оптимизация: если нет промежуточных стейтментов, можно обойтись без do...end
  if (paramAndBodyStmts.length === 0) {
    if (isReturnContext) {
      // Для return вставляем return-стейтмент напрямую, без do...end
      const stmt = lua.createReturnStatement(returnExprs)
      if (context.options.inlineGenerateComment) {
        stmt.leadingComments = [`Start inline ${funcName}`]
        stmt.trailingComments = [`End inline ${funcName}`]
      }
      context.addPrecedingStatements([stmt]);
      return lua.createNilLiteral();
    }

    if (target) {
      if (target.vars.length > 1) {
        // Деструктуризация
        const stmt =
          lua.createAssignmentStatement(
            target.vars, hasMulti ? returnExprs : [returnExprs[0]])
        if (context.options.inlineGenerateComment) {
          stmt.leadingComments = [`Inline ${funcName}`]
        }
        context.addPrecedingStatements([stmt]);
        return lua.createNilLiteral();
      } else {
        // Одна переменная — возвращаем значение для присваивания
        return returnExprs[0];
      }
    }

    // Expression-контекст: просто возвращаем первое выражение
    return returnExprs[0];
  }

  const allStmts = [...paramAndBodyStmts];

  if (isReturnContext) {
    // В контексте return: просто вставляем return в do...end
    allStmts.push(lua.createReturnStatement(hasMulti ? returnExprs : returnExprs));
    const stmt = lua.createDoStatement(allStmts)
    if (context.options.inlineGenerateComment) {
      stmt.leadingComments = [`Start inline ${funcName}`]
      stmt.trailingComments = [`End inline ${funcName}`]
    }
    context.addPrecedingStatements([stmt]);
    return lua.createNilLiteral();
  }

  if (target) {
    if (hasMulti) {
      allStmts.push(lua.createAssignmentStatement(target.vars, returnExprs));
    } else {
      allStmts.push(lua.createAssignmentStatement(target.vars[0], returnExprs[0]));
    }
    if (target.vars.length > 1) {
      // Для деструктуризации возвращаем nil, объявление переменных снаружи
      const stmt = lua.createDoStatement(allStmts)
      if (context.options.inlineGenerateComment) {
        stmt.leadingComments = [`Start inline ${funcName}`]
        stmt.trailingComments = [`End inline ${funcName}`]
      }
      context.addPrecedingStatements([stmt]);
      return lua.createNilLiteral();
    } else {
      // Для одной переменной: возвращаем её, чтобы использовать как expression
      const stmt = lua.createDoStatement(allStmts)
      if (context.options.inlineGenerateComment) {
        stmt.leadingComments = [`Start inline ${funcName}`]
        stmt.trailingComments = [`End inline ${funcName}`]
      }
      context.addPrecedingStatements([stmt]);
      return target.vars[0];
    }
  }

  // Контекст выражения (не присваивание)
  const tempVar = lua.createIdentifier(context.createTempName("inline_result"));
  allStmts.push(lua.createVariableDeclarationStatement(tempVar, hasMulti ? returnExprs[0] : returnExprs[0]));
  const stmt = lua.createDoStatement(allStmts)
  if (context.options.inlineGenerateComment) {
    stmt.leadingComments = [`Start inline ${funcName}`]
    stmt.trailingComments = [`End inline ${funcName}`]
  }
  context.addPrecedingStatements([stmt]);
  return tempVar;
}

export function createInlineAssignment(
  context: TransformationContext,
  funcName: string,
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
  const stmt = lua.createDoStatement(allStmts);
  if (context.options.inlineGenerateComment) {
    stmt.trailingComments = [`End inline ${funcName}`]
  }
  return stmt
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

  const nodeAnnotations = getNodeAnnotations(node);
  return nodeAnnotations.has(AnnotationKind.Inline);
}