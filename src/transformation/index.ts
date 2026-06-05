import * as ts from "typescript";
import * as lua from "../LuaAST";
import { getOrUpdate } from "../utils";
import {
    ObjectVisitor,
    TransformationContext,
    VisitorMap,
    Visitors,
    getOrCreateProgramInlineFunctions,
} from "./context";
import { standardVisitors } from "./visitors";
import { usingTransformer } from "./pre-transformers/using-transformer";
import { AnnotationKind, getSymbolAnnotations } from "./utils/annotations";
import {parseInlineAnnotationArgs} from "./utils/inline";

// Track which programs have been scanned for inline functions
const scannedPrograms = new WeakSet<ts.Program>();

export function createVisitorMap(customVisitors: Visitors[]): VisitorMap {
    const objectVisitorMap: Map<ts.SyntaxKind, Array<ObjectVisitor<ts.Node>>> = new Map();
    for (const visitors of [standardVisitors, ...customVisitors]) {
        const priority = visitors === standardVisitors ? -Infinity : 0;
        for (const [syntaxKindKey, visitor] of Object.entries(visitors)) {
            if (!visitor) continue;

            const syntaxKind = Number(syntaxKindKey) as ts.SyntaxKind;
            const nodeVisitors = getOrUpdate(objectVisitorMap, syntaxKind, () => []);

            const objectVisitor: ObjectVisitor<any> =
                typeof visitor === "function" ? { transform: visitor, priority } : visitor;
            nodeVisitors.push(objectVisitor);
        }
    }

    const result: VisitorMap = new Map();
    for (const [kind, nodeVisitors] of objectVisitorMap) {
        result.set(
            kind,
            nodeVisitors.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map(visitor => visitor.transform)
        );
    }
    return result;
}

function collectInlineFunctionsFromSourceFile(program: ts.Program, sourceFile: ts.SourceFile): void {
    const inlineFunctions = getOrCreateProgramInlineFunctions(program);
    const checker = program.getTypeChecker();

    function visit(node: ts.Node): void {
        // Handle function declarations
        if (ts.isFunctionDeclaration(node) && node.name && node.body) {
            const symbol = checker.getSymbolAtLocation(node.name);
            if (symbol) {
                const annotations = getSymbolAnnotations(symbol);
                const inlineAnnotation = annotations.get(AnnotationKind.Inline);
                if (inlineAnnotation) {

                    const { removeDeclaration } =
                      parseInlineAnnotationArgs(program.getCompilerOptions(), inlineAnnotation);

                    inlineFunctions.set(symbol, {
                        node,
                        parameters: node.parameters,
                        body: node.body,
                        sourceFile,
                        removeDeclaration
                    });
                }
            }
        }

        // Handle const/let/var declarations with arrow functions or function expressions
        if (ts.isVariableStatement(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (
                    declaration.initializer &&
                    (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) &&
                    ts.isIdentifier(declaration.name)
                ) {
                    const symbol = checker.getSymbolAtLocation(declaration.name);
                    if (symbol) {
                        const annotations = getSymbolAnnotations(symbol);
                        const inlineAnnotation = annotations.get(AnnotationKind.Inline);
                        if (inlineAnnotation && declaration.initializer.body) {

                            const { removeDeclaration } =
                              parseInlineAnnotationArgs(program.getCompilerOptions(), inlineAnnotation);

                            inlineFunctions.set(symbol, {
                                node: declaration.initializer,
                                parameters: declaration.initializer.parameters,
                                body: declaration.initializer.body,
                                sourceFile,
                                removeDeclaration
                            });
                        }
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
}

function ensureInlineFunctionsCollected(program: ts.Program): void {
    if (scannedPrograms.has(program)) {
        return; // Already scanned this program
    }

    // Mark as scanned first to prevent infinite recursion
    scannedPrograms.add(program);

    // Scan all source files for inline functions
    const allSourceFiles = program.getSourceFiles();
    for (const sourceFile of allSourceFiles) {
        if (!sourceFile.isDeclarationFile) {
            collectInlineFunctionsFromSourceFile(program, sourceFile);
        }
    }
}

export function transformSourceFile(program: ts.Program, sourceFile: ts.SourceFile, visitorMap: VisitorMap) {
    // Ensure all inline functions are collected before transforming any file
    ensureInlineFunctionsCollected(program);

    const context = new TransformationContext(program, sourceFile, visitorMap);

    // TS -> TS pre-transformation
    const preTransformers = [usingTransformer(context)];
    const result = ts.transform(sourceFile, preTransformers);

    // TS -> Lua transformation
    const [file] = context.transformNode(result.transformed[0]) as [lua.File];

    return { file, diagnostics: context.diagnostics };
}
