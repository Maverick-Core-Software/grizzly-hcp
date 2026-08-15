import assert from 'node:assert/strict';
import {
  formatDisplayAddress,
  normalizeState,
  normalizeUsPhone,
  titleCaseAddressPart,
} from './contact-normalize.js';

assert.equal(normalizeUsPhone('9728163944'), '9728163944');
assert.equal(normalizeUsPhone('+1 (972) 816-3944'), '9728163944');
assert.equal(normalizeUsPhone('1-972-816-3944'), '9728163944');
assert.equal(normalizeUsPhone(''), undefined);
assert.equal(normalizeUsPhone('123'), undefined);

assert.equal(titleCaseAddressPart('703 BUCKBOARD ST'), '703 Buckboard St');
assert.equal(titleCaseAddressPart('OVILLA'), 'Ovilla');
assert.equal(titleCaseAddressPart('1600 PENNSYLVANIA AVENUE NW'), '1600 Pennsylvania Avenue NW');
assert.equal(normalizeState('tx'), 'TX');
assert.equal(normalizeState('Texas'), 'Texas');

assert.equal(
  formatDisplayAddress({
    street: '703 Buckboard St',
    city: 'Ovilla',
    state: 'TX',
    zip: '75154',
  }),
  '703 Buckboard St, Ovilla, TX 75154',
);

console.log('contact-normalize.check OK');
