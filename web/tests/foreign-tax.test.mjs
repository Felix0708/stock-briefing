import assert from 'node:assert/strict';
import test from 'node:test';
import { taxWon, foreignTax, saleScenario, TAX_YEAR } from '../src/lib/foreign-tax.ts';

test('2026 US/JP tax combines signed gains and one deduction without treating missing as zero',()=>{
  assert.equal(TAX_YEAR,2026);
  for(const value of ['', ' ', '1e6', 'NaN', 'Infinity', '1.2', '1000000000001', '1,000']) assert.equal(taxWon(value),null);
  assert.equal(taxWon('-100'),-100);assert.equal(taxWon('-100',false),null);assert.equal(taxWon('0'),0);
  assert.deepEqual(foreignTax(10_000_000,-2_000_000),{gain:8_000_000,taxable:5_500_000,national:1_100_000,local:110_000,tax:1_210_000,net:6_790_000});
  assert.equal(foreignTax(2_000_000,2_000_000).tax,330_000);
  assert.equal(foreignTax(-10_000_000,2_000_000).tax,0);
  assert.equal(foreignTax(2_500_000,0).tax,0);
  assert.equal(foreignTax(NaN,0),null);assert.equal(foreignTax(0.1,0),null);
  assert.deepEqual(saleScenario(8_000_000,1_804_000,1_000_000,4_000),{gain:800_000,additionalTax:176_000,net:624_000,annualTax:1_386_000});
  assert.equal(saleScenario(8_000_000,1_000_000,2_000_000,0).additionalTax,-220_000);
  assert.equal(saleScenario(0,null,0,0),null);assert.equal(saleScenario(0,10,-1,0),null);
});
