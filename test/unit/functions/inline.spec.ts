// import * as util from "../../util";
// import {
//     inlineComplexBody,
//     inlineNestedInlineCall,
//     inlineRecursiveCall,
// } from "../../../src/transformation/utils/diagnostics";
//
// describe("inline functions", () => {
//     test("basic inline function", () => {
//         util.testFunction`
//             /** @inline */
//             function add(a: number, b: number): number {
//                 return a + b;
//             }
//
//             const result = add(5, 3);
//             return result;
//         `.expectToEqual(8);
//     });
//
//     test("inline arrow function", () => {
//         util.testFunction`
//             /** @inline */
//             const multiply = (a: number, b: number): number => a * b;
//
//             const result = multiply(4, 5);
//             return result;
//         `.expectToEqual(20);
//     });
//
//     test("inline function with expression body", () => {
//         util.testFunction`
//             /** @inline */
//             function square(x: number): number {
//                 return x * x;
//             }
//
//             return square(7);
//         `.expectToEqual(49);
//     });
//
//     test("inline function called multiple times", () => {
//         util.testFunction`
//             /** @inline */
//             function double(x: number): number {
//                 return x * 2;
//             }
//
//             const a = double(5);
//             const b = double(10);
//             return a + b;
//         `.expectToEqual(30);
//     });
//
//     test("inline function across files", () => {
//         util.testModule`
//             import { increment } from "./utils";
//
//             export const result = increment(10);
//         `
//             .addExtraFile(
//                 "utils.ts",
//                 `
//                 /** @inline */
//                 export function increment(x: number): number {
//                     return x + 1;
//                 }
//                 `
//             )
//             .expectToMatchJsResult();
//     });
//
//     test("inline function with complex expression", () => {
//         util.testFunction`
//             /** @inline */
//             function clamp(value: number, min: number, max: number): number {
//                 return value < min ? min : value > max ? max : value;
//             }
//
//             return clamp(15, 0, 10);
//         `.expectToEqual(10);
//     });
//
//     // Validation tests
//     test("recursive inline function should error", () => {
//         util.testFunction`
//             /** @inline */
//             function factorial(n: number): number {
//                 return n <= 1 ? 1 : n * factorial(n - 1);
//             }
//
//             return factorial(5);
//         `.expectDiagnosticsToMatchSnapshot([inlineRecursiveCall.code]);
//     });
//
//     test("inline function calling another inline should error", () => {
//         util.testFunction`
//             /** @inline */
//             function double(x: number): number {
//                 return x * 2;
//             }
//
//             /** @inline */
//             function quadruple(x: number): number {
//                 return double(double(x));
//             }
//
//             return quadruple(5);
//         `.expectDiagnosticsToMatchSnapshot([inlineNestedInlineCall.code]);
//     });
//
//     test("inline function with complex body should error", () => {
//         util.testFunction`
//             /** @inline */
//             function sum(a: number, b: number): number {
//                 let result = a + b;
//                 return result;
//             }
//
//             return sum(5, 3);
//         `.expectDiagnosticsToMatchSnapshot([inlineComplexBody.code]);
//     });
// });
