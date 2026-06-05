import * as lua from "./LuaAST";

/**
 * Visitor function type for Lua AST nodes
 * Returns void for inspection, or a modified node for transformation
 */
export type LuaVisitor<T = void> = (node: lua.Node) => T | undefined;

/**
 * Result type for visitors that can return multiple nodes
 */
export type LuaVisitorResult<T extends lua.Node> = T | T[] | undefined;

/**
 * Walks through all nodes in the Lua AST using depth-first traversal
 * Calls the visitor function for each node encountered
 *
 * Stops at the first non-undefined result returned by the visitor
 *
 * @example
 * // Find the first identifier in an AST
 * const firstId = visitNode(file, (node) => {
 *     if (lua.isIdentifier(node)) {
 *         return node;
 *     }
 * });
 *
 * @example
 * // Check if AST contains a specific pattern
 * const hasFunctionCall = visitNode(file, (node) => {
 *     if (lua.isCallExpression(node)) {
 *         return true;
 *     }
 * }) ?? false;
 */
export function visitNode<T>(node: lua.Node, visitor: LuaVisitor<T>): T | undefined {
    const result = visitor(node);
    if (result !== undefined) {
        return result;
    }

    // Visit children based on node type
    if (lua.isFile(node)) {
        for (const statement of node.statements) {
            const childResult = visitNode(statement, visitor);
            if (childResult !== undefined) {
                return childResult;
            }
        }
    } else if (lua.isBlock(node)) {
        for (const statement of node.statements) {
            const childResult = visitNode(statement, visitor);
            if (childResult !== undefined) {
                return childResult;
            }
        }
    } else if (lua.isDoStatement(node)) {
        for (const statement of node.statements) {
            const childResult = visitNode(statement, visitor);
            if (childResult !== undefined) {
                return childResult;
            }
        }
    } else if (lua.isVariableDeclarationStatement(node)) {
        for (const identifier of node.left) {
            const childResult = visitNode(identifier, visitor);
            if (childResult !== undefined) {
                return childResult;
            }
        }
        if (node.right) {
            for (const expression of node.right) {
                const childResult = visitNode(expression, visitor);
                if (childResult !== undefined) {
                    return childResult;
                }
            }
        }
    } else if (lua.isAssignmentStatement(node)) {
        for (const left of node.left) {
            const childResult = visitNode(left, visitor);
            if (childResult !== undefined) {
                return childResult;
            }
        }
        for (const right of node.right) {
            const childResult = visitNode(right, visitor);
            if (childResult !== undefined) {
                return childResult;
            }
        }
    } else if (lua.isIfStatement(node)) {
        const conditionResult = visitNode(node.condition, visitor);
        if (conditionResult !== undefined) {
            return conditionResult;
        }
        const ifBlockResult = visitNode(node.ifBlock, visitor);
        if (ifBlockResult !== undefined) {
            return ifBlockResult;
        }
        if (node.elseBlock) {
            const elseBlockResult = visitNode(node.elseBlock, visitor);
            if (elseBlockResult !== undefined) {
                return elseBlockResult;
            }
        }
    } else if (lua.isWhileStatement(node)) {
        const conditionResult = visitNode(node.condition, visitor);
        if (conditionResult !== undefined) {
            return conditionResult;
        }
        const bodyResult = visitNode(node.body, visitor);
        if (bodyResult !== undefined) {
            return bodyResult;
        }
    } else if (lua.isRepeatStatement(node)) {
        const bodyResult = visitNode(node.body, visitor);
        if (bodyResult !== undefined) {
            return bodyResult;
        }
        const conditionResult = visitNode(node.condition, visitor);
        if (conditionResult !== undefined) {
            return conditionResult;
        }
    } else if (lua.isForStatement(node)) {
        const controlVarResult = visitNode(node.controlVariable, visitor);
        if (controlVarResult !== undefined) {
            return controlVarResult;
        }
        const initializerResult = visitNode(node.controlVariableInitializer, visitor);
        if (initializerResult !== undefined) {
            return initializerResult;
        }
        const limitResult = visitNode(node.limitExpression, visitor);
        if (limitResult !== undefined) {
            return limitResult;
        }
        if (node.stepExpression) {
            const stepResult = visitNode(node.stepExpression, visitor);
            if (stepResult !== undefined) {
                return stepResult;
            }
        }
        const bodyResult = visitNode(node.body, visitor);
        if (bodyResult !== undefined) {
            return bodyResult;
        }
    } else if (lua.isForInStatement(node)) {
        for (const name of node.names) {
            const nameResult = visitNode(name, visitor);
            if (nameResult !== undefined) {
                return nameResult;
            }
        }
        for (const expression of node.expressions) {
            const exprResult = visitNode(expression, visitor);
            if (exprResult !== undefined) {
                return exprResult;
            }
        }
        const bodyResult = visitNode(node.body, visitor);
        if (bodyResult !== undefined) {
            return bodyResult;
        }
    } else if (lua.isReturnStatement(node)) {
        for (const expression of node.expressions) {
            const childResult = visitNode(expression, visitor);
            if (childResult !== undefined) {
                return childResult;
            }
        }
    } else if (lua.isExpressionStatement(node)) {
        const childResult = visitNode(node.expression, visitor);
        if (childResult !== undefined) {
            return childResult;
        }
    } else if (lua.isFunctionExpression(node)) {
        if (node.params) {
            for (const param of node.params) {
                const childResult = visitNode(param, visitor);
                if (childResult !== undefined) {
                    return childResult;
                }
            }
        }
        if (node.dots) {
            const dotsResult = visitNode(node.dots, visitor);
            if (dotsResult !== undefined) {
                return dotsResult;
            }
        }
        const bodyResult = visitNode(node.body, visitor);
        if (bodyResult !== undefined) {
            return bodyResult;
        }
    } else if (lua.isTableExpression(node)) {
        for (const field of node.fields) {
            const childResult = visitNode(field, visitor);
            if (childResult !== undefined) {
                return childResult;
            }
        }
    } else if (lua.isTableFieldExpression(node)) {
        if (node.key) {
            const keyResult = visitNode(node.key, visitor);
            if (keyResult !== undefined) {
                return keyResult;
            }
        }
        const valueResult = visitNode(node.value, visitor);
        if (valueResult !== undefined) {
            return valueResult;
        }
    } else if (lua.isUnaryExpression(node)) {
        const childResult = visitNode(node.operand, visitor);
        if (childResult !== undefined) {
            return childResult;
        }
    } else if (lua.isBinaryExpression(node)) {
        const leftResult = visitNode(node.left, visitor);
        if (leftResult !== undefined) {
            return leftResult;
        }
        const rightResult = visitNode(node.right, visitor);
        if (rightResult !== undefined) {
            return rightResult;
        }
    } else if (lua.isCallExpression(node)) {
        const exprResult = visitNode(node.expression, visitor);
        if (exprResult !== undefined) {
            return exprResult;
        }
        for (const param of node.params) {
            const childResult = visitNode(param, visitor);
            if (childResult !== undefined) {
                return childResult;
            }
        }
    } else if (lua.isMethodCallExpression(node)) {
        const prefixResult = visitNode(node.prefixExpression, visitor);
        if (prefixResult !== undefined) {
            return prefixResult;
        }
        const nameResult = visitNode(node.name, visitor);
        if (nameResult !== undefined) {
            return nameResult;
        }
        for (const param of node.params) {
            const childResult = visitNode(param, visitor);
            if (childResult !== undefined) {
                return childResult;
            }
        }
    } else if (lua.isTableIndexExpression(node)) {
        const tableResult = visitNode(node.table, visitor);
        if (tableResult !== undefined) {
            return tableResult;
        }
        const indexResult = visitNode(node.index, visitor);
        if (indexResult !== undefined) {
            return indexResult;
        }
    } else if (lua.isParenthesizedExpression(node)) {
        const childResult = visitNode(node.expression, visitor);
        if (childResult !== undefined) {
            return childResult;
        }
    } else if (lua.isConditionalExpression(node)) {
        const conditionResult = visitNode(node.condition, visitor);
        if (conditionResult !== undefined) {
            return conditionResult;
        }
        const trueResult = visitNode(node.whenTrue, visitor);
        if (trueResult !== undefined) {
            return trueResult;
        }
        const falseResult = visitNode(node.whenFalse, visitor);
        if (falseResult !== undefined) {
            return falseResult;
        }
    }

    return undefined;
}

/**
 * Walks through ALL nodes in the Lua AST (not stopping at first result)
 * Useful for collecting information or performing side effects
 *
 * @example
 * // Count all function calls in the AST
 * let callCount = 0;
 * visitAllNodes(file, (node) => {
 *     if (lua.isCallExpression(node)) {
 *         callCount++;
 *     }
 * });
 * console.log(`Found ${callCount} function calls`);
 *
 * @example
 * // Collect all identifiers
 * const identifiers: lua.Identifier[] = [];
 * visitAllNodes(file, (node) => {
 *     if (lua.isIdentifier(node)) {
 *         identifiers.push(node);
 *     }
 * });
 *
 * @example
 * // Validate AST - check for invalid patterns
 * visitAllNodes(file, (node) => {
 *     if (lua.isBinaryExpression(node)) {
 *         // Check for division by zero or other issues
 *         if (/* your validation logic *\/) {
 *             throw new Error("Invalid pattern found");
 *         }
 *     }
 * });
 */
export function visitAllNodes(node: lua.Node, visitor: LuaVisitor): void {
    visitor(node);

    // Visit children based on node type
    if (lua.isFile(node)) {
        for (const statement of node.statements) {
            visitAllNodes(statement, visitor);
        }
    } else if (lua.isBlock(node)) {
        for (const statement of node.statements) {
            visitAllNodes(statement, visitor);
        }
    } else if (lua.isDoStatement(node)) {
        for (const statement of node.statements) {
            visitAllNodes(statement, visitor);
        }
    } else if (lua.isVariableDeclarationStatement(node)) {
        for (const identifier of node.left) {
            visitAllNodes(identifier, visitor);
        }
        if (node.right) {
            for (const expression of node.right) {
                visitAllNodes(expression, visitor);
            }
        }
    } else if (lua.isAssignmentStatement(node)) {
        for (const left of node.left) {
            visitAllNodes(left, visitor);
        }
        for (const right of node.right) {
            visitAllNodes(right, visitor);
        }
    } else if (lua.isIfStatement(node)) {
        visitAllNodes(node.condition, visitor);
        visitAllNodes(node.ifBlock, visitor);
        if (node.elseBlock) {
            visitAllNodes(node.elseBlock, visitor);
        }
    } else if (lua.isWhileStatement(node)) {
        visitAllNodes(node.condition, visitor);
        visitAllNodes(node.body, visitor);
    } else if (lua.isRepeatStatement(node)) {
        visitAllNodes(node.body, visitor);
        visitAllNodes(node.condition, visitor);
    } else if (lua.isForStatement(node)) {
        visitAllNodes(node.controlVariable, visitor);
        visitAllNodes(node.controlVariableInitializer, visitor);
        visitAllNodes(node.limitExpression, visitor);
        if (node.stepExpression) {
            visitAllNodes(node.stepExpression, visitor);
        }
        visitAllNodes(node.body, visitor);
    } else if (lua.isForInStatement(node)) {
        for (const name of node.names) {
            visitAllNodes(name, visitor);
        }
        for (const expression of node.expressions) {
            visitAllNodes(expression, visitor);
        }
        visitAllNodes(node.body, visitor);
    } else if (lua.isReturnStatement(node)) {
        for (const expression of node.expressions) {
            visitAllNodes(expression, visitor);
        }
    } else if (lua.isExpressionStatement(node)) {
        visitAllNodes(node.expression, visitor);
    } else if (lua.isFunctionExpression(node)) {
        if (node.params) {
            for (const param of node.params) {
                visitAllNodes(param, visitor);
            }
        }
        if (node.dots) {
            visitAllNodes(node.dots, visitor);
        }
        visitAllNodes(node.body, visitor);
    } else if (lua.isTableExpression(node)) {
        for (const field of node.fields) {
            visitAllNodes(field, visitor);
        }
    } else if (lua.isTableFieldExpression(node)) {
        if (node.key) {
            visitAllNodes(node.key, visitor);
        }
        visitAllNodes(node.value, visitor);
    } else if (lua.isUnaryExpression(node)) {
        visitAllNodes(node.operand, visitor);
    } else if (lua.isBinaryExpression(node)) {
        visitAllNodes(node.left, visitor);
        visitAllNodes(node.right, visitor);
    } else if (lua.isCallExpression(node)) {
        visitAllNodes(node.expression, visitor);
        for (const param of node.params) {
            visitAllNodes(param, visitor);
        }
    } else if (lua.isMethodCallExpression(node)) {
        visitAllNodes(node.prefixExpression, visitor);
        visitAllNodes(node.name, visitor);
        for (const param of node.params) {
            visitAllNodes(param, visitor);
        }
    } else if (lua.isTableIndexExpression(node)) {
        visitAllNodes(node.table, visitor);
        visitAllNodes(node.index, visitor);
    } else if (lua.isParenthesizedExpression(node)) {
        visitAllNodes(node.expression, visitor);
    } else if (lua.isConditionalExpression(node)) {
        visitAllNodes(node.condition, visitor);
        visitAllNodes(node.whenTrue, visitor);
        visitAllNodes(node.whenFalse, visitor);
    }
}

/**
 * Collects all nodes of a specific kind from the AST
 *
 * @example
 * // Get all identifiers in the file
 * const identifiers = collectNodes(file, lua.SyntaxKind.Identifier);
 *
 * @example
 * // Get all function calls
 * const calls = collectNodes(file, lua.SyntaxKind.CallExpression);
 *
 * @example
 * // Get all string literals
 * const strings = collectNodes(file, lua.SyntaxKind.StringLiteral);
 * console.log(strings.map(s => s.value));
 */
export function collectNodes<K extends lua.SyntaxKind>(node: lua.Node, kind: K): Array<Extract<lua.Node, { kind: K }>> {
    const results: Array<Extract<lua.Node, { kind: K }>> = [];

    visitAllNodes(node, n => {
        if (n.kind === kind) {
            results.push(n as Extract<lua.Node, { kind: K }>);
        }
    });

    return results;
}

/**
 * Transforms nodes in the AST by replacing them with visitor results
 * Returns a new AST with transformations applied (immutable - original is not modified)
 *
 * The transformer function should return:
 * - A new node to replace the current one
 * - undefined to keep the current node and continue transforming children
 *
 * @example
 * // Replace all identifiers named "oldName" with "newName"
 * const newFile = transformNode(file, (node) => {
 *     if (lua.isIdentifier(node) && node.text === "oldName") {
 *         return lua.createIdentifier("newName");
 *     }
 * });
 *
 * @example
 * // Wrap all numeric literals in parentheses
 * const wrappedFile = transformNode(file, (node) => {
 *     if (lua.isNumericLiteral(node)) {
 *         return lua.createParenthesizedExpression(node);
 *     }
 * });
 *
 * @example
 * // Convert all addition operations to multiplication
 * const transformed = transformNode(file, (node) => {
 *     if (lua.isBinaryExpression(node) && node.operator === lua.SyntaxKind.AdditionOperator) {
 *         return lua.createBinaryExpression(node.left, node.right, lua.SyntaxKind.MultiplicationOperator);
 *     }
 * });
 *
 * @example
 * // Add logging to all function calls
 * const loggedFile = transformNode(file, (node) => {
 *     if (lua.isCallExpression(node)) {
 *         // Transform call into: print("Calling function"); originalCall()
 *         const logStatement = lua.createExpressionStatement(
 *             lua.createCallExpression(
 *                 lua.createIdentifier("print"),
 *                 [lua.createStringLiteral("Function called")]
 *             )
 *         );
 *         // Note: This is a simplified example. Real implementation would need
 *         // to handle statement context properly
 *     }
 * });
 */
export function transformNode<T extends lua.Node>(node: T, transformer: LuaVisitor<lua.Node>): T {
    const transformed = transformer(node);
    if (transformed !== undefined) {
        return transformed as any as T;
    }

    // Transform children based on node type
    if (lua.isFile(node)) {
        const newStatements = node.statements.map(stmt => transformNode(stmt, transformer));
        return lua.createFile(newStatements, node.luaLibFeatures, node.trivia) as any as T;
    } else if (lua.isBlock(node)) {
        const newStatements = node.statements.map(stmt => transformNode(stmt, transformer));
        return lua.createBlock(newStatements) as any as T;
    } else if (lua.isDoStatement(node)) {
        const newStatements = node.statements.map(stmt => transformNode(stmt, transformer));
        return lua.createDoStatement(newStatements) as any as T;
    } else if (lua.isVariableDeclarationStatement(node)) {
        const newLeft = node.left.map(id => transformNode(id, transformer));
        const newRight = node.right?.map(expr => transformNode(expr, transformer));
        return lua.createVariableDeclarationStatement(newLeft, newRight) as any as T;
    } else if (lua.isAssignmentStatement(node)) {
        const newLeft = node.left.map(expr => transformNode(expr, transformer));
        const newRight = node.right.map(expr => transformNode(expr, transformer));
        return lua.createAssignmentStatement(newLeft, newRight) as any as T;
    } else if (lua.isIfStatement(node)) {
        const newCondition = transformNode(node.condition, transformer);
        const newIfBlock = transformNode(node.ifBlock, transformer);
        const newElseBlock = node.elseBlock ? transformNode(node.elseBlock, transformer) : undefined;
        return lua.createIfStatement(newCondition, newIfBlock, newElseBlock) as any as T;
    } else if (lua.isWhileStatement(node)) {
        const newCondition = transformNode(node.condition, transformer);
        const newBody = transformNode(node.body, transformer);
        return lua.createWhileStatement(newBody, newCondition) as any as T;
    } else if (lua.isRepeatStatement(node)) {
        const newBody = transformNode(node.body, transformer);
        const newCondition = transformNode(node.condition, transformer);
        return lua.createRepeatStatement(newBody, newCondition) as any as T;
    } else if (lua.isForStatement(node)) {
        const newControlVar = transformNode(node.controlVariable, transformer);
        const newInitializer = transformNode(node.controlVariableInitializer, transformer);
        const newLimit = transformNode(node.limitExpression, transformer);
        const newStep = node.stepExpression ? transformNode(node.stepExpression, transformer) : undefined;
        const newBody = transformNode(node.body, transformer);
        return lua.createForStatement(newBody, newControlVar, newInitializer, newLimit, newStep) as any as T;
    } else if (lua.isForInStatement(node)) {
        const newNames = node.names.map(name => transformNode(name, transformer));
        const newExpressions = node.expressions.map(expr => transformNode(expr, transformer));
        const newBody = transformNode(node.body, transformer);
        return lua.createForInStatement(newBody, newNames, newExpressions) as any as T;
    } else if (lua.isReturnStatement(node)) {
        const newExpressions = node.expressions.map(expr => transformNode(expr, transformer));
        return lua.createReturnStatement(newExpressions) as any as T;
    } else if (lua.isExpressionStatement(node)) {
        const newExpression = transformNode(node.expression, transformer);
        return lua.createExpressionStatement(newExpression) as any as T;
    } else if (lua.isFunctionExpression(node)) {
        const newParams = node.params?.map(param => transformNode(param, transformer));
        const newDots = node.dots ? transformNode(node.dots, transformer) : undefined;
        const newBody = transformNode(node.body, transformer);
        return lua.createFunctionExpression(newBody, newParams, newDots, node.flags) as any as T;
    } else if (lua.isTableExpression(node)) {
        const newFields = node.fields.map(field => transformNode(field, transformer));
        return lua.createTableExpression(newFields) as any as T;
    } else if (lua.isTableFieldExpression(node)) {
        const newKey = node.key ? transformNode(node.key, transformer) : undefined;
        const newValue = transformNode(node.value, transformer);
        return lua.createTableFieldExpression(newValue, newKey) as any as T;
    } else if (lua.isUnaryExpression(node)) {
        const newOperand = transformNode(node.operand, transformer);
        return lua.createUnaryExpression(newOperand, node.operator) as any as T;
    } else if (lua.isBinaryExpression(node)) {
        const newLeft = transformNode(node.left, transformer);
        const newRight = transformNode(node.right, transformer);
        return lua.createBinaryExpression(newLeft, newRight, node.operator) as any as T;
    } else if (lua.isCallExpression(node)) {
        const newExpression = transformNode(node.expression, transformer);
        const newParams = node.params.map(param => transformNode(param, transformer));
        return lua.createCallExpression(newExpression, newParams) as any as T;
    } else if (lua.isMethodCallExpression(node)) {
        const newPrefix = transformNode(node.prefixExpression, transformer);
        const newName = transformNode(node.name, transformer);
        const newParams = node.params.map(param => transformNode(param, transformer));
        return lua.createMethodCallExpression(newPrefix, newName, newParams) as any as T;
    } else if (lua.isTableIndexExpression(node)) {
        const newTable = transformNode(node.table, transformer);
        const newIndex = transformNode(node.index, transformer);
        return lua.createTableIndexExpression(newTable, newIndex) as any as T;
    } else if (lua.isParenthesizedExpression(node)) {
        const newExpression = transformNode(node.expression, transformer);
        return lua.createParenthesizedExpression(newExpression) as any as T;
    } else if (lua.isConditionalExpression(node)) {
        const newCondition = transformNode(node.condition, transformer);
        const newWhenTrue = transformNode(node.whenTrue, transformer);
        const newWhenFalse = transformNode(node.whenFalse, transformer);
        return lua.createConditionalExpression(newCondition, newWhenTrue, newWhenFalse) as any as T;
    }

    return node;
}

/**
 * Finds the first node matching a predicate
 *
 * @example
 * // Find first function call in the AST
 * const firstCall = findNode(file, (node) => lua.isCallExpression(node));
 *
 * @example
 * // Find first identifier with a specific name
 * const myVar = findNode(file, (node) =>
 *     lua.isIdentifier(node) && node.text === "myVariable"
 * );
 *
 * @example
 * // Find first table expression with more than 5 fields
 * const largeTable = findNode(file, (node) =>
 *     lua.isTableExpression(node) && node.fields.length > 5
 * );
 *
 * @example
 * // Find nested pattern: a call expression inside an if statement
 * let foundCall: lua.CallExpression | undefined;
 * let inIfStatement = false;
 *
 * findNode(file, (node) => {
 *     if (lua.isIfStatement(node)) {
 *         inIfStatement = true;
 *     }
 *     if (inIfStatement && lua.isCallExpression(node)) {
 *         foundCall = node;
 *         return node; // Stop searching
 *     }
 * });
 */
export function findNode(node: lua.Node, predicate: (node: lua.Node) => boolean): lua.Node | undefined {
    let found: lua.Node | undefined;

    visitNode(node, n => {
        if (predicate(n)) {
            found = n;
            return n;
        }
        return undefined;
    });

    return found;
}
