<div align="center">
    <img src="logo-hq.png?raw=true" alt="TypeScriptToLua" width="256" />
    <h1>
        <p>TypeScriptToLua (PIKO8 Fork)</p>
        <a href="https://github.com/TypeScriptToLua/TypeScriptToLua/actions"><img alt="CI status" src="https://github.com/TypeScriptToLua/TypeScriptToLua/workflows/CI/badge.svg" /></a>
        <a href="https://codecov.io/gh/TypeScriptToLua/TypeScriptToLua"><img alt="Coverage" src="https://img.shields.io/codecov/c/gh/TypeScriptToLua/TypeScriptToLua.svg?logo=codecov" /></a>
        <a href="https://discord.gg/BWAq58Y"><img alt="Chat with us!" src="https://img.shields.io/discord/515854149821267971.svg?colorB=7581dc&logo=discord&logoColor=white"></a>
    </h1>
    <a href="https://typescripttolua.github.io/" target="_blank">Original Documentation</a>
    |
    <a href="https://typescripttolua.github.io/play/" target="_blank">Try Online (Original)</a>
    |
    <a href="https://github.com/PIKO8/TypeScriptToLua/blob/master/CHANGELOG.md">Changelog</a>
    |
    <a href="https://github.com/PIKO8/TypeScriptToLua/blob/master/CONTRIBUTING.md">Contribution guidelines</a>
</div>

---

> **Note:** This is a custom experimental fork of [TypeScriptToLua](https://github.com/TypeScriptToLua/TypeScriptToLua) modified by **PIKO8**. It introduces a compiler-level `@inline` optimization pass for micro-optimizations and zero-overhead lambdas.

## 🚀 Key Improvements in this Fork

The main goal of this fork is to bring **Kotlin-style zero-overhead `@inline` functions** to TypeScriptToLua. Unlike experimental community plugins, this feature is baked directly into the compiler engine, supporting deep cross-file analysis and complex control flows.

### 1. Cross-File Macro Inlining
* Functions marked with JSDoc `/** @inline */` are completely unwrapped into the calling expression/statement.
* Works seamlessly across different files and modules via strict TS Symbol aliasing resolution.

### 2. High-Order Functions & Lambda Optimization
* Fully supports inlining functions that accept other functions (lambdas/callbacks) as arguments (e.g., custom `filter`, `map`, `forEach`).
* Arrow functions and inline expressions are embedded into loops and conditions without creating closures or allocating anonymous tables in Lua.

### 3. Adaptive Control Flow (Target-Specific Compilation)
* **Lua 5.2+, JIT, Luau**: Translates deep `return` statements in complex multi-return lambdas into high-performance native `goto` jumps with macro hygiene (guaranteed unique labels).
* **Lua 5.1 / Universal**: Automatically downgrades complex control flow into efficient state-machine blocks using temporary execution flags (`____done_...`), ensuring 100% runtime compatibility.

### 4. Zero-Overhead Fast Path & `$multi` Integration
* Triivial functions (single trailing return expressions) skip block overhead and flatten directly into equations or native multiple assignments.
* Perfect cooperation with `LuaMultiReturn` / `$multi` compiler macro.

### 5. New CLI / tsconfig.json compiler options
* `inlineGenerateComment`: (boolean) Generates `-- Start inline [name]` annotations directly in the emitted Lua files to simplify debugging.
* `inlineRemoveDefault`: (boolean) Globally toggles whether to strip the original inline function declarations from the compiled output. Can be overridden per function via `/** @inline toggle */`.

---

## 🛠️ Quick Example

### TypeScript Source Code
```typescript
/** @inline */
function filter<T>(arr: T[], pred: (x: T) => boolean): T[] {
    const result: T[] = [];
    for (const item of arr) {
        if (pred(item)) result.push(item);
    }
    return result;
}

export function test() {
    const data = [1, 2, 3, 4, 5, 6];
    
    // Inlining simple conditions
    const evens = filter(data, (n) => n % 2 == 0);
    
    // Inlining heavy block expressions with early returns
    const withBlock = filter(data, (n) => {
        if (n == 3) return true;
        return n > 4;
    });
    
    return [evens, withBlock];
}
```

### Transpiled Zero-Overhead Lua Output (Lua 5.2+)
```lua
function ____exports.test(self)
    local data = {1, 2, 3, 4, 5, 6}
    local evens
    do
        local result = {}
        for ____, item in ipairs(data) do
            if item % 2 == 0 then
                result[#result + 1] = item
            end
        end
        evens = result
    end
    local withBlock
    do
        local result = {}
        for ____, item in ipairs(data) do
            local ____lambdaResult_0 = nil
            do
                if item == 3 then
                    ____lambdaResult_0 = true
                    goto ____inline_end_1
                end
                ____lambdaResult_0 = item > 4
                ::____inline_end_1::
            end
            if ____lambdaResult_0 then
                result[#result + 1] = item
            end
        end
        withBlock = result
    end
    return {evens, withBlock}
end
```
> 💡 **Note on Variable Naming:** To make this example easy to read, some variable names have been manually cleaned up. In actual generated Lua code, the compiler enforces strict **macro hygiene** by automatically renaming local variables and arguments inside inline blocks (e.g., transforming `item` into `____item_inline_1`). This ensures complete scope isolation and completely prevents name collision bugs with the surrounding code!
---

## ⚠️ Known Limitations & AI Disclaimer

This inliner was developed as a powerful custom extension of the compiler. While it passes all core integration tests, please keep the following trade-offs and architectural quirks in mind:

### 1. Short-circuit Evaluation Side-Effects
* **The Issue:** If you use inline functions inside logical conditions (e.g., `if (isValid() && fetchProps())`), the compiler hoists evaluation do-blocks *before* executing the `if` statement itself.
* **The Result:** Both inline functions will **always** be executed, even if the first one returns `false`. This can cause unexpected side-effects. It is highly recommended to store inline function results in local variables manually before using them in complex conditional logic.

### 2. Emitted Code Debugging (Source Maps)
* Deeply nested inlining of complex statements—especially with state-machine generation for older Lua 5.1 targets—can complicate accurate runtime line debugging.
* To make code tracking easier during development, always enable the `--inlineGenerateComment true` flag.

### 3. 🤖 AI-Assisted Development Notice
* About **70% of this compiler fork's logic was built in collaboration with AI (Qwen)** directly inside the IDE.
* Because of this AI-driven approach, some edge cases might still be unhandled, and deep internal refactoring can be highly complex. However, it completely fulfills its goal for practical, micro-optimization tasks! "It works on my machine" ™️ — use it with care and feel free to submit PRs for any bugs you find.


# Original README

A generic TypeScript to Lua transpiler. Write your code in TypeScript and publish Lua!

Large projects written in Lua can become hard to maintain and make it easy to make mistakes. Writing code in TypeScript instead improves maintainability, readability and robustness, with the added bonus of good [tooling] support (including [ESLint], [Prettier], [Visual Studio Code] and [WebStorm]). This project is useful in any environment where Lua code is accepted, with the powerful option of simply declaring any existing API using TypeScript declaration files.

[tooling]: https://typescripttolua.github.io/docs/editor-support
[eslint]: https://eslint.org/
[prettier]: https://prettier.io/
[visual studio code]: https://code.visualstudio.com/
[webstorm]: https://www.jetbrains.com/webstorm/

## Getting Started

To install TypeScriptToLua add the `typescript-to-lua` npm package:

```bash
$ npm install -D typescript-to-lua
```

This package includes the `tstl` command line application, which can be used similarly to `tsc`:

```
$ npx tstl
```

For more information, check out [Getting Started](https://typescripttolua.github.io/docs/getting-started) in our documentation.
