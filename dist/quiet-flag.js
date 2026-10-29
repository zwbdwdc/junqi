import {legalMoves,combat,isHQ,roadEdges,TYPES} from './engine.js';
const other=side=>side==='ai'?'human':'ai';
let guardSerial=0;

// Coarse public keys merge all opponent identities. This upper bound may
// miss a proof, but cannot ignore a possible historical repetition draw.
export function createFlagDrawGuard(observation=null){
 const side=observation?.side||'ai',own=Object.fromEntries((observation?.ownRoster||[]).map(p=>[p.id,p.type]));
 const key=(board,turn)=>`${turn}|${board.map(p=>!p?'-':p.side===side?own[p.id]||p.type:'?').join(',')}`;
 const counts=new Map(),lineCounts=new Map(),stack=[];let blocked=0,context=`g${++guardSerial}`;
 if(observation){
  const board=Array(observation.board.length).fill(null);
  for(const p of observation.ownRoster||[])board[p.origin]={...p,side};
  for(const p of observation.enemyRoster||[])board[p.origin]={...p,side:other(side)};
  const remember=turn=>{const k=key(board,turn);counts.set(k,(counts.get(k)||0)+1);};
  remember('human');
  for(const event of observation.history||[]){
   const attacker=board[event.from]||{id:event.attackerId,side:event.side};board[event.from]=null;
   if(event.result==='move'||event.result==='win')board[event.to]=attacker;
   else if(event.result==='both')board[event.to]=null;
   remember(other(event.side));
  }
 }
 const wouldDraw=(board,turn)=>{const k=key(board,turn);return (counts.get(k)||0)+(lineCounts.get(k)||0)>=2;};
 return {wouldDraw,isBlocked:()=>blocked>0,context:()=>context,
  withPosition(board,turn,callback){
   const k=key(board,turn),draw=wouldDraw(board,turn),oldContext=context;
   stack.push(k);lineCounts.set(k,(lineCounts.get(k)||0)+1);if(draw)blocked++;
   context+=`>${k}`;
   try{return callback();}finally{context=oldContext;stack.pop();const n=lineCounts.get(k)-1;if(n)lineCounts.set(k,n);else lineCounts.delete(k);if(draw)blocked--;}
  },depth:()=>stack.length};
}

const hasMove=(board,side)=>board.some((p,at)=>p?.side===side&&legalMoves(board,at).length>0);
const neighbors=Array.from({length:62},()=>[]);
for(const[a,b]of roadEdges){neighbors[a].push(b);neighbors[b].push(a);}
export const fastFlagExposed=(board,side)=>{
 const at=board.findIndex(p=>p?.side===side&&p.type==='flag');
 if(isHQ(at))return neighbors[at].some(from=>{const p=board[from];return p&&p.side!==side&&TYPES[p.type]&&!['mine','flag'].includes(p.type)&&!isHQ(from);});
 return at>=0&&board.some((p,from)=>p&&p.side!==side&&legalMoves(board,from).includes(at));
};
function project(board,from,to){
 const attacker=board[from],target=board[to],result=target?combat(attacker.type,target.type):'move',next=board.slice();
 next[from]=null;next[to]=result==='lose'?target:result==='both'?null:{...attacker,moved:true};return next;
}

/** Per-hypothesis proof only: after a quiet checking move, EVERY legal
 * defender reply must leave a direct flag capture. Counterwins and draws
 * refute it. Caller keeps ordinary leaf score if this limited proof fails. */
export function quietFlagMate(board,attackerSide,quiet,statistics,check,hasMoves=hasMove){
 const defenderSide=other(attackerSide),guard=statistics.flagDrawGuard;
 if(!fastFlagExposed(board,defenderSide))return false;
 statistics.flagThreatProbes=(statistics.flagThreatProbes||0)+1;
 if(quiet>=100||guard?.isBlocked()||guard?.wouldDraw(board,defenderSide))return false;
 let replies=0;
 for(let from=0;from<board.length;from++)if(board[from]?.side===defenderSide){
  check(statistics);
  for(const to of legalMoves(board,from)){
   statistics.nodes++;statistics.replies++;statistics.flagThreatReplyNodes=(statistics.flagThreatReplyNodes||0)+1;check(statistics);replies++;
   const target=board[to],next=project(board,from,to);
   // Capturing a flag (including bomb trade) and no-moves wins precede draws.
   if(target?.type==='flag'||!hasMoves(next,attackerSide))return false;
   if(!target&&quiet+1>=100)return false;
   if(guard?.wouldDraw(next,attackerSide))return false;
   if(!fastFlagExposed(next,defenderSide))return false;
  }
 }
 if(!replies)return false; // Caller already handles immediate no-moves wins.
 statistics.flagThreatMates=(statistics.flagThreatMates||0)+1;return true;
}
