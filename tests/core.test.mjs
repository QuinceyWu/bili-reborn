import { md5 } from '../src/core/md5.ts';
import { bvToAv, avToBv } from '../src/core/bvid.ts';

let pass = 0;
let fail = 0;

function check(name, actual, expect) {
  if (actual === expect) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + ' → ' + actual); }
}

check('md5 empty', md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
check('md5 abc', md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
check('md5 sentence', md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
check('bvToAv', String(bvToAv('BV17x411w7KC')), '170001');
check('avToBv', avToBv(170001), 'BV17x411w7KC');
check('bv roundtrip', avToBv(bvToAv('BV1GJ411x7h7')), 'BV1GJ411x7h7');

console.log('---');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
