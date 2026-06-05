import * as util from "../../util";
import {LuaTarget} from "../../../src";

test("@inline simple scalars and expression lambdas", () => {
    util.testModule`
        /** @inline */
        function add(a: number, b: number): number { return a + b; }
        /** @inline */
        function apply<T,R>(v: T, fn: (x: T) => R): R { return fn(v); }

        export function test() {
            const r1 = add(2, 3);
            const r2 = apply(10, (x) => x * 2);
            const r3 = apply(5, (x) => x + 1);
            return [r1, r2, r3];
        }
    `.expectLuaToMatchSnapshot();
});

test("@inline block lambda and destructuring", () => {
    util.testModule`
        /** @inline */
        function apply2<T,R>(v: T, fn: (x: T) => R): R { return fn(v); }
        /** @inline */
        function getPair(): LuaMultiReturn<[number, string]> { return $multi(42, "hello"); }

        export function test() {
            const r1 = apply2(5, (x) => {
                const temp = x * 2;
                return temp + 1;
            });
            const [num, str] = getPair();
            return [r1, num, str];
        }
    `
      .withLanguageExtensions()
      .expectLuaToMatchSnapshot();
});

test("@inline in for and if", () => {
    util.testModule`
        /** @inline */
        function filter<T>(arr: T[], pred: (x: T) => boolean): T[] {
            const result: T[] = [];
            for (const item of arr) {
                if (pred(item)) result.push(item);
            }
            return result;
        }

        export function test() {
            const data = [1,2,3,4,5,6];
            const evens = filter(data, (n) => n % 2 == 0);
            const withBlock = filter(data, (n) => {
                if (n == 3) return true;
                return n > 4;
            });
            return [evens, withBlock];
        }
    `.expectLuaToMatchSnapshot();
});

test("@inline chained and multi-return lambda", () => {
    util.testModule`
        /** @inline */
        function apply<T,R>(v: T, fn: (x: T) => R): R { return fn(v); }
        /** @inline */
        function choose<T>(cond: boolean, onTrue: () => T, onFalse: () => T): T {
            return cond ? onTrue() : onFalse();
        }

        export function test() {
            const a = apply(3, (x) => apply(x, (y) => y * 2));
            const b = choose(true, () => 100, () => 200);
            return [a, b];
        }
    `.expectLuaToMatchSnapshot();
});

test("@inline side effects and closure", () => {
    util.testModule`
        /** @inline */
        function forEach<T>(arr: T[], body: (x: T) => void): void {
            for (const item of arr) { body(item); }
        }

        export function test() {
            let sum = 0;
            forEach([1,2,3], (n) => { sum += n; });
            return sum;
        }
    `.expectLuaToMatchSnapshot();
});

test("@inline multi returns in lambda", () => {
    util.testModule`
        /** @inline */
        function apply<T, R>(value: T, block: (this: void, value: T) => R): R { return block(value) }
        
        export function test() {
            const random = Math.random()
            const a = apply(random, (value) => {
                if (value === 10) return "ten"
                if (value < 0) return "down zero"
                if (value > 10) return "up ten"
                return "down ten"
            })
        }  
    `.expectLuaToMatchSnapshot()
})

test("@inline multi returns in lambda lua 5.1", () => {
    util.testModule`
        /** @inline */
        function apply<T, R>(value: T, block: (this: void, value: T) => R): R { return block(value) }
        
        export function test() {
            const random = Math.random()
            const a = apply(random, (value) => {
                if (value === 10) return "ten"
                if (value < 0) return "down zero"
                if (value > 10) return "up ten"
                return "down ten"
            })
        }  
    `
      .setOptions({ luaTarget: LuaTarget.Lua51 })
      .expectLuaToMatchSnapshot()
})