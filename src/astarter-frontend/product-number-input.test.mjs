import test from 'node:test';
import assert from 'node:assert/strict';
import {numberInputParts,numberInputConfiguration,isNumberInput} from './product-number-input.mjs';

const text=parts=>parts.map(part=>part.char).join('');
test('grouped presentation preserves precision and sign without numeric conversion',()=>{
 for(const [raw,expected]of [['1234567.890000001','1,234,567.890000001'],['-1234.5','-1,234.5'],['0012.30','12.30'],['9007199254740993','9,007,199,254,740,993'],['1e-8','1e-8'],['-0','-0']])assert.equal(text(numberInputParts(raw)),expected);
});
test('empty and zero differ, and missing fractional places are display-only ghosts',()=>{
 const empty=numberInputParts('',2),zero=numberInputParts('0',2),fraction=numberInputParts('12.3',2);
 assert.equal(text(empty),'0.00');assert.ok(empty.every(part=>part.ghost));
 assert.equal(text(zero),'0.00');assert.equal(zero[0].ghost,false);assert.ok(zero.slice(1).every(part=>part.ghost));
 assert.equal(text(fraction),'12.30');assert.equal(fraction.at(-1).ghost,true);assert.equal(fraction.at(-2).ghost,false);
 assert.equal(text(numberInputParts('0.00000001',2)),'0.00000001');
 assert.equal(text(numberInputParts('0.123456789',NaN)),'0.123456789');
});
test('place keys retain the ones column across digit-count changes',()=>{
 const before=numberInputParts('9'),after=numberInputParts('10');
 assert.equal(before[0].key,'i0');assert.equal(after[1].key,'i0');assert.equal(after[0].key,'i1');
});
const input=(attributes={},extras={})=>({localName:'input',type:attributes.type||'number',inputMode:attributes.inputmode||'',placeholder:attributes.placeholder||'',parentElement:{children:[]},labels:[],getAttribute:key=>attributes[key]??null,hasAttribute:key=>key in attributes,closest:()=>null,...extras});
test('numeric quantities are eligible while verification codes, dates and explicit exclusions stay native',()=>{
 assert.equal(isNumberInput(input()),true);
 assert.equal(isNumberInput(input({type:'text',inputmode:'decimal'})),true);
 for(const attributes of [{type:'text',inputmode:'numeric'},{type:'date'},{type:'number',autocomplete:'one-time-code'},{type:'number','data-number-exclude':''}])assert.equal(isNumberInput(input(attributes)),false);
});
test('fraction hints follow existing currency or step metadata and never rewrite a field',()=>{
 const amount=input({step:'any'},{labels:[{textContent:'Allocation · USDT'}]}),price=input({step:'0.00000001'}),count=input({step:'1'}),explicit=input({'data-number-fraction-digits':'3'});
 for(const field of [amount,price,count,explicit])Object.defineProperty(field,'value',{get:()=> '0.123456789',set(){throw new Error('numeric presentation must not set value');}});
 assert.equal(numberInputConfiguration(amount).minimumFractionDigits,2);
 assert.equal(numberInputConfiguration(price).minimumFractionDigits,8);
 assert.equal(numberInputConfiguration(count).minimumFractionDigits,0);
 assert.equal(numberInputConfiguration(explicit).minimumFractionDigits,3);
});
