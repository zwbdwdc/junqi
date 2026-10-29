import test from 'node:test';
import assert from 'node:assert/strict';
import { publicDanger } from '../dist/ai.js';
import { legalMoves } from '../dist/engine.js';

const unit=(id,type,side='ai')=>({id,type,side,moved:true});
const beliefs={domains:{enemy:['engineer']},probabilities:{enemy:{engineer:1}}};

test('a permanently boxed brigade does not hide the last actual mobile unit',()=>{
  const board=Array(62).fill(null);
  board[1]=unit('flag','flag');board[3]=unit('hq','platoon');board[7]=unit('mine','mine');
  board[2]=unit('brigade','brigade');board[5]=unit('last','engineer');board[10]=unit('enemy','engineer','human');
  assert.deepEqual(legalMoves(board,2),[]);
  assert.ok(legalMoves(board,5).length);
  assert.ok(legalMoves(board,10).includes(5));
  assert.equal(publicDanger(board,beliefs,'ai').lastUnitRisk,1);
});

test('an exchange that frees a temporarily blocked officer is not a no-moves loss',()=>{
  const board=Array(62).fill(null);
  board[1]=unit('flag','flag');board[0]=unit('brigade','brigade');
  board[5]=unit('last','engineer');board[10]=unit('enemy','engineer','human');
  assert.deepEqual(legalMoves(board,0),[]);
  const after=board.slice();after[5]=null;after[10]=null;
  assert.ok(legalMoves(after,0).includes(5));
  assert.equal(publicDanger(board,beliefs,'ai').lastUnitRisk,0);
});

test('the same no-moves check works with the sides and board rotated',()=>{
  const board=Array(62).fill(null);
  board[58]=unit('flag','flag','human');board[56]=unit('hq','platoon','human');board[52]=unit('mine','mine','human');
  board[57]=unit('brigade','brigade','human');board[54]=unit('last','engineer','human');board[49]=unit('enemy','engineer','ai');
  assert.deepEqual(legalMoves(board,57),[]);
  assert.equal(publicDanger(board,beliefs,'human').lastUnitRisk,1);
});
