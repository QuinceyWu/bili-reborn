import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const code = readFileSync(new URL('../tampermonkey/bili-wiper.user.js', import.meta.url), 'utf8');
const noop = () => {};
const sandbox = {
  console,
  setTimeout, clearTimeout, Promise, Date, Math, JSON,
  encodeURIComponent, decodeURIComponent, unescape, escape,
  String, Object, Array, Error, parseInt, parseFloat, isNaN,
  Int32Array, Uint32Array,
  localStorage: { getItem: () => null, setItem: noop },
  document: {
    readyState: 'loading',
    addEventListener: noop,
    getElementById: () => null,
    createElement: () => ({ style: {} }),
    body: { appendChild: noop }
  }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.top = sandbox;
createContext(sandbox);
runInContext(code, sandbox);

const B = sandbox.__BAW__;
let pass = 0;
let fail = 0;
function check(name, actual, expect) {
  if (actual === expect) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + ' → ' + actual); }
}

check('userscript loaded', typeof B, 'object');
check('md5', B.md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
check('bvToAv', B.bvToAv('BV17x411w7KC'), 170001);
const NL = String.fromCharCode(10);
check('parseOidInput count', B.parseOidInput(['BV17x411w7KC', 'av12345', 'https://t.bilibili.com/98765'].join(NL)).length, 3);
check('wbi sign has w_rid', B.wbi.sign({ a: 1 }, 'k1', 'k2').indexOf('w_rid=') > 0, true);

console.log('---');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
