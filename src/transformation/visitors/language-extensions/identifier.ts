import * as ts from "typescript";
import { ExtensionKind } from "../../utils/language-extensions";
import { TransformationContext } from "../../context";
import { invalidMultiFunctionUse, invalidRangeUse, invalidVarargUse } from "../../utils/diagnostics";
import {findFirstNodeAbove} from "../../utils/typescript";
import {isInlineFunctionCandidate} from "../../utils/inline";

const extensionKindToValueName: { [T in ExtensionKind]?: string } = {
    [ExtensionKind.MultiFunction]: "$multi",
    [ExtensionKind.RangeFunction]: "$range",
    [ExtensionKind.VarargConstant]: "$vararg",
};
export function isIdentifierExtensionValue(symbol: ts.Symbol | undefined, extensionKind: ExtensionKind): boolean {
    return symbol !== undefined && extensionKindToValueName[extensionKind] === symbol.name;
}

export function isInReturnStatementWithMulti(identifier: ts.Identifier): boolean {
    let node: ts.Node = identifier;
    while (
      node.parent &&
      (ts.isParenthesizedExpression(node.parent) ||
        ts.isAsExpression(node.parent) ||
        ts.isTypeAssertionExpression(node.parent))
      ) {
        node = node.parent;
    }
    return ts.isReturnStatement(node.parent) && node.parent.expression === node;
}

export function reportInvalidExtensionValue(
    context: TransformationContext,
    identifier: ts.Identifier,
    extensionKind: ExtensionKind
): void {
    if (extensionKind === ExtensionKind.MultiFunction) {
        if (isInReturnStatementWithMulti(identifier)) return

        const enclosingFunc = findFirstNodeAbove(identifier, ts.isFunctionLike);
        if (enclosingFunc && isInlineFunctionCandidate(context, enclosingFunc)) return;

        context.diagnostics.push(invalidMultiFunctionUse(identifier));
    } else if (extensionKind === ExtensionKind.RangeFunction) {
        context.diagnostics.push(invalidRangeUse(identifier));
    } else if (extensionKind === ExtensionKind.VarargConstant) {
        context.diagnostics.push(invalidVarargUse(identifier));
    }
}
