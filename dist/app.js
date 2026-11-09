import { TYPES, isCamp, isHQ, isMountain, railEdges, roadEdges, canPlace, randomLayout, legalMoves, validateLayout, createGame, applyMove, makeObservation, revealedEngineerIds } from './engine.js';
import { createAILayout } from './formations.js';
import { buildReplay, describeReplay } from './replay.js';
import { captureBattlePieces, playBattleEffect, clearBattleEffect } from './battle-effects.js';
import { createLearningProfile, sanitizeProfile, learnFromGame } from './learning.js';
import { createAIContext, sanitizeAIContext, decisionDiagnostics } from './ai-context.js';
import { sanitizeMarks } from './piece-marks.js';
import { drawFirstTurn } from './first-turn.js';

const $ = selector => document.querySelector(selector);
const names = { professional:'职业', hell:'地狱' };
const descriptions = { professional:'攻守均衡。', hell:'推演更深，思考稍久。' };
const STORE='junqi-session-v2', LAYOUT='junqi-layout-v1', LEARNING='junqi-learning-v1';
let setup=randomLayout('human'), game=null, difficulty='professional', selected=null, reserve=null, thinking=false, worker=null, requestId=0;
let pointerDrag=null, suppressClick=false, replay=null, replayTimer=null;
let pieceMarks=Object.create(null), markTarget=null, markAnchor=null;
let learning=createLearningProfile();
const archivedGames=new Map();
let finalization=Promise.resolve(), learningGeneration=0, restoringExperience=false;
let sessionSaveFailed=false, messageText=$('#message').textContent, messageError=false;
try{learning=sanitizeProfile(JSON.parse(localStorage.getItem(LEARNING)));}catch{}
const pos = i => i>=60?[i===60?150:350,332]:[50+(i%5)*100, 38+Math.floor(i/5)*50+(i>=30?38:0)];
const coord = i => i>=60?(i===60?'左山界':'右山界'):`${'ABCDE'[i%5]}${12-Math.floor(i/5)}`;
const count = (board,side) => board.filter(p=>p?.side===side).length;

function renderMessage(){
  const box=$('#message');box.textContent=messageText;box.classList.toggle('error',messageError||sessionSaveFailed);
  if(!sessionSaveFailed)return;
  const warning=document.createElement('div');warning.id='session-save-warning';warning.setAttribute('role','alert');
  warning.textContent='当前进度尚未保存。可以继续下棋，但关闭后可能丢失。';
  const retry=document.createElement('button');retry.id='retry-session-save';retry.className='quiet';retry.textContent='重试保存';
  retry.onclick=event=>{event.stopPropagation();if(persist())message('当前进度已保存。');};
  warning.append(retry);box.append(warning);
}
function message(text,error=false) { messageText=text;messageError=error;renderMessage(); }
function publicEnemyIds(){const ids=game?revealedEngineerIds(game):new Set();if(game?.revealedFlags?.ai){const flag=game.board.find(p=>p?.side==='ai'&&p.type==='flag');if(flag)ids.add(flag.id);}return ids;}
function persist(){
  pieceMarks=sanitizeMarks(pieceMarks,game?.board,publicEnemyIds());
  try{localStorage.setItem(STORE,JSON.stringify({version:1,setup,game,difficulty,marks:pieceMarks}));sessionSaveFailed=false;renderMessage();return true;}
  catch{sessionSaveFailed=true;renderMessage();return false;}
}
function restore(){try{const data=JSON.parse(localStorage.getItem(STORE));if(data?.version!==1)return;if(Array.isArray(data.setup)&&data.setup.length===60)setup=data.setup;if(data.game?.board?.length===62 && Array.isArray(data.game.history))game=data.game;if(names[data.difficulty])difficulty=data.difficulty;pieceMarks=sanitizeMarks(data.marks,game?.board,publicEnemyIds());}catch{message('未能恢复上次对局，已重新准备棋盘。');}}

function closeMarkMenu(restoreFocus=false){const anchor=markAnchor;markTarget=null;markAnchor=null;$('#mark-menu').classList.add('hidden');if(restoreFocus)anchor?.focus();}
function openMarkMenu(index,event){
  closeMarkMenu();
  const piece=game?.board[index];
  if(replay||!game||game.result||piece?.side!=='ai'||publicEnemyIds().has(piece.id))return;
  markTarget=piece.id;markAnchor=$(`.cell[data-index="${index}"]`);
  const menu=$('#mark-menu');
  menu.querySelectorAll('[data-mark]').forEach(button=>button.setAttribute('aria-pressed',String(pieceMarks[piece.id]===button.dataset.mark)));
  $('#clear-mark').disabled=!pieceMarks[piece.id];
  menu.classList.remove('hidden');
  const anchor=markAnchor.getBoundingClientRect(),rect=menu.getBoundingClientRect();
  const x=event.clientX||anchor.right,y=event.clientY||anchor.top;
  menu.style.left=`${Math.max(8,Math.min(x,innerWidth-rect.width-8))}px`;
  menu.style.top=`${Math.max(8,Math.min(y,innerHeight-rect.height-8))}px`;
  (menu.querySelector('[aria-pressed="true"]')||menu.querySelector('[data-mark]')).focus();
}
function setPieceMark(type){
  if(!markTarget||!game||game.result||replay)return closeMarkMenu();
  const piece=game.board.find(p=>p?.id===markTarget&&p.side==='ai');
  if(!piece||publicEnemyIds().has(piece.id))return closeMarkMenu();
  if(type)pieceMarks[piece.id]=type;else delete pieceMarks[piece.id];
  closeMarkMenu(true);persist();render();
  message(type?`已标记为“${TYPES[type].name}？”。`:'已清除标记。');
}
for(const [type,meta] of Object.entries(TYPES)){
  const button=document.createElement('button');button.className='secondary';button.dataset.mark=type;button.textContent=meta.name;button.onclick=()=>setPieceMark(type);$('#mark-options').append(button);
}
$('#clear-mark').onclick=()=>setPieceMark(null);
$('#close-mark').onclick=()=>closeMarkMenu(true);
document.addEventListener('pointerdown',event=>{if(markTarget&&!$('#mark-menu').contains(event.target))closeMarkMenu();});
window.addEventListener('resize',()=>closeMarkMenu());

function finishLearning(){
  if(!game?.result)return;
  // The full referee record is supplied ONLY after the game ends; future AI workers receive aggregate weights, never this record.
  game.gameId ||= 'legacy-'+game.initial.find(p=>p?.side==='ai').id;
  game.finishedAt ||= new Date().toISOString();
  if(window.junqiArchive&&window.junqiExperience?.review){
    finalization=archiveFinishedGame(game,difficulty);
    return finalization;
  }
  archiveFinishedGame(game,difficulty);
  if(game.skipRestoredExperience)return;
  const previousGames=learning.games;
  learning=learnFromGame(learning,{gameId:game.gameId,observation:makeObservation(game,'ai'),decisions:game.aiDecisions||[],completedGame:game});
  if(learning.games!==previousGames)saveExperience();
}
function acceptSavedLearning(result){
  if(result?.profile){learning=sanitizeProfile(result.profile);try{localStorage.setItem(LEARNING,JSON.stringify(learning));}catch{}}
  $('#learning-storage').textContent=result?.error||'已自动保存';
  if(result?.ok===false)message('经验暂未保存，将在下次打开时重试。',true);
}
function archiveFinishedGame(finishedGame,level){
  if(!window.junqiArchive)return Promise.resolve();
  if(archivedGames.has(finishedGame.gameId))return archivedGames.get(finishedGame.gameId);
  const generation=learningGeneration;
  const pending=window.junqiArchive.save({game:finishedGame,difficulty:level,finishedAt:finishedGame.finishedAt})
    .catch(error=>({ok:false,error:error.message})).then(result=>{
      if(!result.ok){archivedGames.delete(finishedGame.gameId);message('棋谱保存失败：'+result.error,true);}
      else if(result.learning&&generation===learningGeneration){
        acceptSavedLearning(result.learning);
        if(result.learning.ok===false)archivedGames.delete(finishedGame.gameId);
        render();
      }
      return result;
    });
  archivedGames.set(finishedGame.gameId,pending);
  return pending;
}
async function openHistory(){
  if(game&&!game.result)return;
  stopReplay();if(replay)render();
  const list=$('#history-list'),empty=$('#history-empty');list.innerHTML='';empty.textContent='正在读取…';$('#history-dialog').showModal();
  if(!window.junqiArchive){empty.textContent='请在桌面软件中查看历史棋谱。';return;}
  const result=await window.junqiArchive.list().catch(error=>({ok:false,error:error.message}));
  if(!result.ok){empty.textContent='读取失败：'+result.error;return;}
  empty.textContent=result.games.length?'最近 100 局，自动保存。':'还没有保存的棋谱。完成一局后会出现在这里。';
  for(const item of result.games){
    const button=document.createElement('button');button.className='history-entry';
    const title=document.createElement('strong'),detail=document.createElement('span');
    title.textContent=`${names[item.difficulty]} · ${item.result.winner==='human'?'你赢了':item.result.winner==='ai'?'电脑获胜':'和棋'}`;
    detail.textContent=`${new Date(item.finishedAt).toLocaleString('zh-CN',{hour12:false})} · ${item.ply} 步`;
    button.append(title,detail);button.onclick=async()=>{
      button.disabled=true;
      const loaded=await window.junqiArchive.load(item.id).catch(error=>({ok:false,error:error.message}));
      button.disabled=false;
      if(!loaded.ok){empty.textContent='棋谱无法打开：'+loaded.error;return;}
      $('#history-dialog').close();enterReplay(loaded.record.game,loaded.record.difficulty);
    };list.append(button);
  }
}
async function saveExperience(){
  let localOK=true;
  try{localStorage.setItem(LEARNING,JSON.stringify(learning));}catch{localOK=false;}
  if(window.junqiExperience){
    const result=await window.junqiExperience.save(learning).catch(error=>({ok:false,error:error.message}));
    $('#learning-storage').textContent=result.ok?'已自动保存':'保存失败，请备份经验。';
    if(!result.ok)message('经验保存失败：'+result.error,true);
  }else $('#learning-storage').textContent=localOK?'已自动保存':'经验保存失败，请备份经验。';
}
async function initialize(){
  if(window.junqiExperience){
    try{
      const saved=await window.junqiExperience.load();
      acceptSavedLearning(saved);
      if(!saved.profile&&learning.games>0&&!saved.error)await saveExperience();
    }catch(error){$('#learning-storage').textContent='经验文件读取失败：'+error.message;}
  }
  restore();await finishLearning();drawRoutes();render();
  if(game){message('已恢复上次对局。');if(game.turn==='ai'&&!game.result)startAI();}
}
function stopReplay(){clearInterval(replayTimer);replayTimer=null;}
function leaveReplay(){stopReplay();clearBattleEffect($('#board'));replay=null;selected=null;render();}
function replayAt(index){
  if(!replay)return;
  const previous=replay.index, next=Math.max(0,Math.min(replay.frames.length-1,index));
  const event=replay.frames[next].event;
  const pieces=next===previous+1&&event?captureBattlePieces($('#board'),event.from,event.to):null;
  replay.index=next;
  if(replay.index===replay.frames.length-1)stopReplay();
  clearBattleEffect($('#board'));render();
  if(pieces)playBattleEffect($('#board'),event,pieces);
}
function enterReplay(replayGame=game,level=difficulty){
  if(!replayGame?.result||game&&!game.result)return;
  closeMarkMenu();
  try{stopReplay();clearBattleEffect($('#board'));replay={game:replayGame,difficulty:level,frames:buildReplay(replayGame),index:0};selected=null;reserve=null;pointerDrag=null;render();message('方向键逐步查看，空格播放或暂停。');}
  catch(error){message('复盘无法打开：'+error.message,true);}
}
function toggleReplayPlay(){
  if(!replay)return;
  if(replayTimer)stopReplay();
  else{if(replay.index===replay.frames.length-1)replay.index=0;replayTimer=setInterval(()=>replayAt(replay.index+1),1000);}
  render();
}

function drawRoutes(){
  const line=(a,b,cls)=>{const [x1,y1]=pos(a),[x2,y2]=pos(b);return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;};
  $('#routes').innerHTML=roadEdges.map(([a,b])=>line(a,b,'route-road')).join('')+railEdges.map(([a,b])=>line(a,b,'route-rail')).join('')+railEdges.map(([a,b])=>line(a,b,'route-rail-inner')).join('');
  for(let i=0;i<62;i++){
    const cell=document.createElement('button');cell.className='cell';cell.dataset.index=i;
    const [x,y]=pos(i);cell.style.left=`${x/5}%`;cell.style.top=`${y/6.65}%`;
    cell.addEventListener('click',()=>clickCell(i));
    cell.addEventListener('pointerdown',event=>{const piece=(game?.board||setup)[i];if(!replay&&event.button===0&&piece?.side==='human'&&!thinking&&!game?.result)pointerDrag={from:i,x:event.clientX,y:event.clientY,active:false};});
    cell.addEventListener('contextmenu',event=>{event.preventDefault();if(!replay&&!game&&setup[i]?.side==='human'){setup[i]=null;selected=null;render();persist();message('棋子已收回棋盒。');}else openMarkMenu(i,event);});
    $('#stations').append(cell);
  }
}

function render(skipArsenal=false){
  if(markTarget&&(!game||game.result||replay||!game.board.some(p=>p?.id===markTarget)||publicEnemyIds().has(markTarget)))closeMarkMenu();
  const frame=replay?.frames[replay.index], board=frame?.board||game?.board||setup;
  const publicEngineers=game?revealedEngineerIds(game):new Set();
  let targets=[];
  if(!replay && selected!==null && board[selected]?.side==='human') targets=game?legalMoves(board,selected):Array.from({length:60},(_,i)=>i).filter(i=>canSwap(selected,i));
  if(!game&&!replay&&reserve)targets=Array.from({length:60},(_,i)=>i).filter(i=>!board[i]&&canPlace(reserve,'human',i));
  for(const cell of document.querySelectorAll('.cell')){
    const i=Number(cell.dataset.index),piece=board[i],placeholder=!game&&!replay&&i<30&&!isCamp(i);
    cell.className=`cell${isCamp(i)?' camp':''}${isHQ(i)?' hq':''}${isMountain(i)?' mountain':''}${selected===i?' selected':''}${targets.includes(i)?' target':''}${!game&&targets.includes(i)?' placement':''}`;
    const last=replay?frame.event:game?.history?.at(-1);if(last&&(last.from===i||last.to===i))cell.classList.add('last-move');
    let text='',hidden=false,enemy=placeholder||piece?.side==='ai';
    if(placeholder){text='暗';hidden=true;}else if(piece){hidden=!replay&&piece.side==='ai'&&!(piece.type==='flag'&&game?.revealedFlags?.ai)&&!publicEngineers.has(piece.id);text=hidden?'暗':TYPES[piece.type].name;}
    cell.innerHTML=piece||placeholder?`<span class="piece${enemy?' enemy':''}${hidden?' covered':''}"><span>${text}</span></span>`:`<span class="station-name">${isCamp(i)?'行营':isHQ(i)?'本营':isMountain(i)?'山界':''}</span>`;
    const mark=hidden&&piece&&pieceMarks[piece.id];
    if(mark){const badge=document.createElement('span');badge.className='piece-mark';badge.textContent=TYPES[mark].name+'？';cell.append(badge);}
    cell.setAttribute('aria-label',`${coord(i)} ${piece||placeholder?(enemy?'敌方':'我方')+text:isCamp(i)?'行营':isHQ(i)?'大本营':isMountain(i)?'仅工兵可进入，不能被攻击':'空位'}`);
    if(mark)cell.setAttribute('aria-label',cell.getAttribute('aria-label')+`，我的标记：${TYPES[mark].name}`);
    cell.draggable=false;
    cell.title=`${coord(i)}${isCamp(i)?' · 行营':isHQ(i)?' · 大本营':isMountain(i)?' · 工兵入山受保护':''}`;
  }
  $('#setup-panel').classList.toggle('hidden',!!game||!!replay);$('#play-panel').classList.toggle('hidden',!game||!!replay);$('#replay-panel').classList.toggle('hidden',!replay);
  $('#history-btn').disabled=!!game&&!game.result;$('#history-btn').title=game&&!game.result?'本局结束后可查看历史棋谱':'历史棋谱';
  $('#learning-count').textContent=`累计 ${learning.games} 局`;
  $('#import-experience').disabled=restoringExperience||!!game&&!game.result;
  $('#export-experience').disabled=restoringExperience;
  for(const id of ['new-btn','again-btn','replay-again'])$('#'+id).disabled=restoringExperience;
  $('#enemy-count').textContent=`${game||replay?count(board,'ai'):25} 枚`;$('#human-count').textContent=`${count(board,'human')} 枚`;
  $('#enemy-sub').textContent=replay?'明棋复盘':!game?'部署保密':game.revealedFlags?.ai?'军旗已公开':'暗子作战';
  $('#human-sub').textContent=replay?'明棋复盘':!game?'布阵中':game.revealedFlags?.human?'军旗已公开':'红方';
  $('#difficulty-caption').textContent=`${names[replay?.difficulty||difficulty]}难度`;
  $('#status-title').classList.toggle('thinking',thinking);
  if(!game){
    $('#phase-label').textContent='布阵';$('#status-title').textContent='请排兵布阵';$('#status-help').textContent=reserve?`已选${TYPES[reserve].name}，点击高亮位置部署。`:selected!==null?'已选棋子，点击高亮位置移动或换位。':'点击两枚棋子交换位置，也可以拖动布阵。';$('#turn-number').textContent='尚未开战';
    $('#difficulty-help').textContent=descriptions[difficulty];
    document.querySelectorAll('[data-level]').forEach(button=>{button.classList.toggle('active',button.dataset.level===difficulty);button.setAttribute('aria-pressed',String(button.dataset.level===difficulty));});
    if(!skipArsenal)renderArsenal();$('#placed-count').textContent=`已部署 ${count(board,'human')} / 25`;
    $('#start-btn').disabled=restoringExperience||validateLayout(setup,'human').length>0;
    try{$('#load-layout').disabled=!localStorage.getItem(LAYOUT);}catch{$('#load-layout').disabled=false;}
  }else{
    $('#phase-label').textContent=game.result?'战局结束':game.turn==='ai'?'对手回合':'战斗阶段';
    const reasons={flag:'军旗被夺，战局结束。','no-moves':'已没有合法可走的棋子。',quiet:'连续 100 步没有吃子，判为和棋。',repetition:'同一局面出现三次，判为和棋。',resign:game.result?.winner==='human'?'电脑认输，本局结束。':'你已认输，本局结束。'};
    $('#status-title').textContent=game.result?(game.result.winner==='human'?'你赢了':game.result.winner==='ai'?'电脑获胜':'双方和棋'):(thinking?'电脑思考中':game.turn==='ai'?'电脑等待行棋':'轮到你行棋');
    $('#status-help').textContent=game.result?(reasons[game.result.reason]||'本局已结束。'):(thinking?'请稍候。':game.turn==='ai'?'等待电脑行棋。':'选中我方棋子，再点击高亮位置行棋。右键暗子可标记。');
    $('#turn-number').textContent=`第 ${Math.floor(game.ply/2)+1} 回合 · ${game.ply} 步`;
    $('#resign-btn').classList.toggle('hidden',!!game.result);$('#replay-btn').classList.toggle('hidden',!game.result);$('#again-btn').classList.toggle('hidden',!game.result);
    if(!replay)renderLog();
  }
  if(replay){
    $('#phase-label').textContent='明棋复盘';$('#status-title').textContent=replay.index===0?'查看初始布阵':`第 ${replay.index} 步`;
    $('#status-help').textContent=describeReplay(frame,replay.game.initial,coord);$('#turn-number').textContent=`${replay.index} / ${replay.frames.length-1} 步`;
    $('#replay-step').textContent=`第 ${replay.index} / ${replay.frames.length-1} 步`;
    $('#replay-range').max=replay.frames.length-1;$('#replay-range').value=replay.index;
    $('#replay-first').disabled=$('#replay-prev').disabled=replay.index===0;
    $('#replay-next').disabled=$('#replay-last').disabled=replay.index===replay.frames.length-1;
    $('#replay-play').textContent=replayTimer?'暂停':'播放';$('#replay-play').disabled=replay.frames.length<2;
    renderReplayLog();
  }
}

function renderReplayLog(){
  const log=$('#replay-log');
  if(!replay.logButtons){
    log.replaceChildren();
    replay.logButtons=replay.frames.map((item,index)=>{
      const li=document.createElement('li'),button=document.createElement('button');
      button.textContent=`${String(index).padStart(2,'0')}  ${describeReplay(item,replay.game.initial,coord)}`;
      button.className='replay-event';button.onclick=()=>{stopReplay();replayAt(index);};
      li.append(button);log.append(li);return button;
    });
  }
  // Playback controls can render without changing position. Leave the player's
  // scroll and focus alone in that case, and retain the row nodes across steps.
  if(replay.logIndex===replay.index)return;
  const focused=log.contains(document.activeElement),previous=replay.logButtons[replay.logIndex],current=replay.logButtons[replay.index];
  previous?.classList.remove('current');previous?.removeAttribute('aria-current');
  current.classList.add('current');current.setAttribute('aria-current','step');
  replay.logIndex=replay.index;
  if(focused)current.focus({preventScroll:true});
  const row=current.getBoundingClientRect(),bounds=log.getBoundingClientRect();
  log.scrollTop+=row.top-bounds.top-(log.clientHeight-row.height)/2;
}

function renderArsenal(){
  $('#arsenal').innerHTML='';
  for(const [type,meta] of Object.entries(TYPES)){
    const left=meta.count-setup.filter(p=>p?.type===type).length;
    const button=document.createElement('button');button.className=`reserve-piece${left===0?' depleted':''}${reserve===type?' active':''}`;button.innerHTML=`${meta.name}<b>${left}</b>`;button.setAttribute('aria-label',`${meta.name}，剩余${left}枚`);button.disabled=left===0;button.draggable=false;
    button.addEventListener('pointerdown',event=>{if(event.button===0&&left>0)pointerDrag={type,x:event.clientX,y:event.clientY,active:false};});
    button.addEventListener('click',()=>{reserve=reserve===type?null:type;selected=null;render();message(reserve?`选择高亮位置放置${meta.name}。`:'已取消选择。');});
    $('#arsenal').append(button);
  }
}

function canSwap(a,b){if(a===b||!setup[a]||b<30)return false;return canPlace(setup[a].type,'human',b)&&(!setup[b]||canPlace(setup[b].type,'human',a));}
function restriction(type){return type==='flag'?'军旗只能放在大本营。':type==='mine'?'地雷只能放在我方最后两排。':type==='bomb'?'炸弹不能放在最前排；行营内不能布子。':'只能部署在我方空兵站或大本营，行营内不能布子。';}
function clickCell(i){
  if(replay||restoringExperience)return;
  if(!game){
    if(isMountain(i)){message('山界不能用于布阵。开战后，工兵可从周围前线铁路站进入。');return;}
    if(i<30){message('这里是对手阵地，布阵时不可查看或放置棋子。',true);return;}
    if(reserve){
      if(setup[i]){message('这个位置已有棋子，请选空位或先收回原棋子。',true);return;}
      if(!canPlace(reserve,'human',i)){message(restriction(reserve),true);return;}
      const type=reserve;setup[i]={id:crypto.randomUUID(),side:'human',type,origin:i,moved:false};
      if(setup.filter(p=>p?.type===type).length>=TYPES[type].count)reserve=null;
      render();persist();message(`已放置${TYPES[type].name}。`);return;
    }
    if(selected===i){selected=null;render();return;}
    if(selected!==null){
      if(canSwap(selected,i)){const other=setup[i];setup[i]=setup[selected];setup[selected]=other;setup[i].origin=i;if(other)other.origin=selected;selected=null;render();persist();message('阵型已调整。');return;}
      message(restriction(setup[selected].type),true);if(setup[i])selected=i;render();return;
    }
    if(setup[i]){selected=i;render();message('点击高亮位置换位或移动；右键可把棋子收回棋盒。');}else message('先从右侧棋盒选择棋子，再点击位置。');
    return;
  }
  if(game.result){message('本局已结束，可复盘或再来一局。');return;}
  if(thinking||game.turn!=='human'){message('请等待电脑完成行棋。');return;}
  const p=game.board[i];
  if(p?.side==='human'){
    selected=selected===i?null:i;render();
    if(selected!==null&&legalMoves(game.board,i).length===0)message(p.type==='mine'||p.type==='flag'?'地雷和军旗不能移动。':isHQ(i)?'进入大本营的棋子不能再移动。':'这枚棋子暂时没有可走的位置。',true);
    else message('点击高亮位置行棋。');return;
  }
  if(selected===null){message('请先选择我方棋子。');return;}
  if(!legalMoves(game.board,selected).includes(i)){message((isCamp(i)||isMountain(i))&&p?'行营和山界内的棋子不能被攻击。':isMountain(i)?'只有工兵能从周围前线铁路站进入空山界。':'这个位置不能到达，请选择高亮位置。',true);return;}
  commitMove(selected,i);if(!game.result)startAI();
}

function eventText(event){
  const own=(game.initial||[]).find(p=>p?.id===(event.side==='human'?event.attackerId:event.defenderId));
  const ownName=own?TYPES[own.type].name:'棋子';
  const knownEngineers=revealedEngineerIds({history:game.history.filter(item=>item.ply<=event.ply)});
  const enemyAttacker=knownEngineers.has(event.attackerId)?'电脑工兵':'电脑暗子';
  const reveal=event.engineerTurn||event.mountainMove?'；工兵明置':'';
  if(event.result==='move')return `${event.side==='human'?'我方 '+ownName:enemyAttacker} ${coord(event.from)} → ${coord(event.to)}${reveal}`;
  let text;
  if(event.result==='both')text=`${coord(event.to)} 交战，双方同归于尽（我方${ownName}）`;
  else if(event.side==='human')text=event.result==='win'?`我方${ownName}攻克 ${coord(event.to)}，敌子被吃`:`我方${ownName}进攻 ${coord(event.to)} 后阵亡`;
  else text=event.result==='win'?`敌方进攻 ${coord(event.to)}，我方${ownName}阵亡`:`敌方进攻 ${coord(event.to)}，被我方${ownName}击退`;
  if(event.flagRevealed?.length)text+='；'+event.flagRevealed.map(f=>`${f.side==='human'?'我方':'敌方'}司令阵亡，军旗亮出`).join('；');
  if(event.capturedFlagSide)text+=`；${event.capturedFlagSide==='human'?'我方':'敌方'}军旗被夺`;
  return text+reveal;
}
function renderLog(){
  const log=$('#battle-log'),signature=`${game.gameId||game.startedAt}:${game.ply}:${game.result?.reason}:${game.result?.winner}`;
  if(log.dataset.signature===signature)return;
  const follow=log.dataset.gameId!==game.gameId||log.scrollHeight-log.clientHeight-log.scrollTop<32,previousTop=log.scrollTop;
  log.innerHTML='';log.dataset.signature=signature;log.dataset.gameId=game.gameId;
  if(!game.history.length){const li=document.createElement('li');li.textContent=game.firstTurn==='ai'?'战局已开启，本局电脑先手。':'战局已开启，本局你先手。';log.append(li);}
  game.history.slice(-80).forEach((event,index)=>{const li=document.createElement('li');const number=document.createElement('span');number.className='step';number.textContent=String(game.history.length>80?game.history.length-80+index+1:index+1).padStart(2,'0');const text=document.createElement('span');text.textContent=eventText(event);li.append(number,text);log.append(li);});
  if(game.result?.reason==='resign'){const li=document.createElement('li');li.textContent=game.result.winner==='human'?'电脑认输，你赢了。':'我方认输，本局结束。';log.append(li);}
  log.scrollTop=follow?log.scrollHeight:previousTop;
  updateLogFollow();
}
function updateLogFollow(){const log=$('#battle-log');$('#log-latest').classList.toggle('hidden',log.scrollHeight-log.clientHeight-log.scrollTop<32);}
function commitMove(from,to){
  closeMarkMenu();
  try{const pieces=captureBattlePieces($('#board'),from,to);game=applyMove(game,from,to);selected=null;reserve=null;finishLearning();persist();render();const event=game.history.at(-1);playBattleEffect($('#board'),event,pieces);message(eventText(event));}catch(error){message(`无法行棋：${error.message}`,true);}
}
function cancelAI(){requestId++;thinking=false;if(worker){worker.terminate();worker=null;}}
function finishByResignation(side){
  if(!game||game.result)return;
  cancelAI();closeMarkMenu();selected=null;reserve=null;pointerDrag=null;
  game={...game,result:{winner:side==='ai'?'human':'ai',reason:'resign'}};
  finishLearning();persist();render();message(side==='ai'?'电脑认输，你赢了。':'本局已结束。');
}
async function startAI(){
  // Use the last game's confirmed aggregate experience even when a new game
  // is started immediately after its final move.
  await finalization;
  if(!game||game.result||game.turn!=='ai'||thinking)return;
  thinking=true;selected=null;render();const ticket=++requestId;
  // The worker receives only the redacted observation. Never send game or setup.
  const observation=makeObservation(game,'ai');
  const started=performance.now();
  try{
    if(!worker)worker=new Worker(new URL('./ai-worker.js',import.meta.url),{type:'module'});
    const response=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('电脑推演超时')),25000);
      worker.onmessage=event=>{if(event.data.requestId!==ticket)return;clearTimeout(timer);if(event.data.error)reject(new Error(event.data.error));else resolve(event.data);};
      worker.onerror=event=>{clearTimeout(timer);reject(new Error(event.message||'电脑引擎未能启动'));};
      worker.postMessage({observation,difficulty,learningProfile:sanitizeProfile(learning),context:sanitizeAIContext(game.aiContext),requestId:ticket});
    });
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,650-(performance.now()-started))));
    if(ticket!==requestId||!game||game.result)return;
    if(response.resignation?.resign===true){finishByResignation('ai');return;}
    const move=response.move;if(!move||!Number.isInteger(move.from)||!legalMoves(game.board,move.from).includes(move.to)||game.board[move.from]?.side!=='ai')throw new Error('电脑返回了无效走法');
    game.aiDecisions ||= [];
    game.aiDecisions.push({ply:game.ply+1,from:move.from,to:move.to,info:{learningFeatures:move.info?.learningFeatures,actionClass:move.info?.actionClass,diagnostics:decisionDiagnostics(move.info)}});
    thinking=false;commitMove(move.from,move.to);render();
  }catch(error){
    if(ticket!==requestId)return;cancelAI();render();message(`电脑推演中断：${error.message}。点击这里重试。`,true);$('#message').onclick=()=>{$('#message').onclick=null;startAI();};
  }
}
function begin(){
  if(restoringExperience||game||replay)return;
  const errors=validateLayout(setup,'human');
  if(errors.length){message(errors[0],true);return;}
  const firstTurn=drawFirstTurn();
  cancelAI();closeMarkMenu();pieceMarks=Object.create(null);
  game=createGame(setup,createAILayout(difficulty),{engineerMountains:true,firstTurn});
  game.gameId=crypto.randomUUID();game.startedAt=new Date().toISOString();
  game.aiContext=createAIContext(crypto.getRandomValues(new Uint32Array(1))[0]);game.aiDecisions=[];
  selected=null;reserve=null;render();persist();
  message(firstTurn==='ai'?'本局电脑先手。':'本局你先手。');
  if(game.turn==='ai')startAI();
}
function reset(){if(restoringExperience)return;cancelAI();closeMarkMenu();pieceMarks=Object.create(null);stopReplay();clearBattleEffect($('#board'));replay=null;game=null;selected=null;reserve=null;render();persist();message('已返回布阵。可沿用刚才的阵型，或重新部署。');}
function confirmAction(title,text,action){$('#confirm-title').textContent=title;$('#confirm-text').textContent=text;$('#confirm-dialog').showModal();$('#confirm-ok').onclick=()=>{$('#confirm-dialog').close();action();};}
$('#confirm-cancel').onclick=()=>$('#confirm-dialog').close();
$('#rules-btn').onclick=()=>$('#rules-dialog').showModal();$('#settings-btn').onclick=()=>$('#settings-dialog').showModal();document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>document.getElementById(button.dataset.close).close());
$('#history-btn').onclick=openHistory;
$('#new-btn').onclick=()=>game&&!game.result?confirmAction('开始新对局','当前对局将结束，返回布阵。',reset):reset();
$('#random-btn').onclick=()=>{setup=randomLayout('human');selected=null;reserve=null;render();persist();message('已生成合法阵型，可以继续拖动调整。');};
$('#clear-btn').onclick=()=>{setup=Array(60).fill(null);selected=null;reserve=null;render();persist();message('棋盘已清空。先选棋盒中的棋子，再选择位置部署。');};
$('#save-layout').onclick=()=>{if(validateLayout(setup,'human').length){message('请先完成合法的 25 枚棋子布阵，再保存。',true);return;}try{localStorage.setItem(LAYOUT,JSON.stringify(setup));render();message('阵型已保存在本机。');}catch{message('保存失败，本机存储不可用。',true);}};
$('#load-layout').onclick=()=>{try{const data=JSON.parse(localStorage.getItem(LAYOUT));if(!Array.isArray(data)||data.length!==60||validateLayout(data,'human').length)throw new Error();setup=data;selected=null;reserve=null;render();persist();message('已载入保存的阵型。');}catch{message('没有可用的已保存阵型。',true);}};
document.querySelectorAll('[data-level]').forEach(button=>button.onclick=()=>{if(game)return;difficulty=button.dataset.level;render();persist();});
$('#start-btn').onclick=begin;$('#again-btn').onclick=reset;
$('#replay-btn').onclick=()=>enterReplay();$('#replay-exit').onclick=leaveReplay;$('#replay-again').onclick=reset;
$('#replay-first').onclick=()=>{stopReplay();replayAt(0);};$('#replay-prev').onclick=()=>{stopReplay();replayAt(replay.index-1);};
$('#replay-next').onclick=()=>{stopReplay();replayAt(replay.index+1);};$('#replay-last').onclick=()=>{stopReplay();replayAt(replay.frames.length-1);};
$('#replay-play').onclick=toggleReplayPlay;$('#replay-range').oninput=event=>{stopReplay();replayAt(Number(event.target.value));};
$('#resign-btn').onclick=()=>confirmAction('确认认输','认输后本局结束，电脑获胜。',()=>finishByResignation('human'));
window.addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.ctrlKey||event.altKey||event.metaKey)return;
  if(markTarget&&event.key==='Escape'){event.preventDefault();closeMarkMenu(true);return;}
  if(replay&&!document.querySelector('dialog[open]')){
    const target=event.target;
    // Native sliders and text inputs own their keys; focused buttons and links
    // own Space so keyboard users can activate the same controls as the mouse.
    if(target.closest?.('input,select,textarea')||target.isContentEditable||event.key===' '&&target.closest?.('button,a[href]'))return;
    if(['ArrowLeft','ArrowRight',' '].includes(event.key)){
      event.preventDefault();
      if(event.key===' ')toggleReplayPlay();
      else{stopReplay();replayAt(replay.index+(event.key==='ArrowLeft'?-1:1));}
      return;
    }
  }
  if(event.key==='Escape'){selected=null;reserve=null;render();}
});
document.addEventListener('pointermove',event=>{
  if(!pointerDrag||pointerDrag.active||Math.hypot(event.clientX-pointerDrag.x,event.clientY-pointerDrag.y)<7)return;
  pointerDrag.active=true;selected=pointerDrag.type?null:pointerDrag.from;reserve=pointerDrag.type||null;render(true);
});
document.addEventListener('pointerup',event=>{
  const drag=pointerDrag;pointerDrag=null;if(!drag?.active)return;
  const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.cell');
  suppressClick=true;setTimeout(()=>{suppressClick=false;},80);
  if(target)clickCell(Number(target.dataset.index));else render();
});
document.addEventListener('pointercancel',()=>{pointerDrag=null;});
document.addEventListener('click',event=>{if(suppressClick){event.preventDefault();event.stopImmediatePropagation();}},true);
$('#export-experience').onclick=async()=>{
  await finalization;
  if(!window.junqiExperience){message('经验备份请在桌面软件中使用。');return;}
  const result=await window.junqiExperience.export(learning).catch(error=>({error:error.message}));
  if(result.error)message('备份失败：'+result.error,true);else if(!result.cancelled)message('经验备份已保存。');
};
$('#import-experience').onclick=async()=>{
  if(restoringExperience||game&&!game.result)return;
  if(!window.junqiExperience){message('恢复经验请在桌面软件中使用。');return;}
  const result=await window.junqiExperience.import().catch(error=>({error:error.message}));
  if(result.error){message('读取备份失败：'+result.error,true);return;}
  if(result.cancelled||!result.profile)return;
  const imported=sanitizeProfile(result.profile);
  $('#settings-dialog').close();
  confirmAction('恢复经验备份',`将当前 ${learning.games} 局经验替换为备份中的 ${imported.games} 局。建议先备份当前经验。`,()=>{
    if(restoringExperience||game&&!game.result)return;
    restoringExperience=true;
    learningGeneration++;
    const previous=finalization;
    render();
    finalization=(async()=>{
      try{
        await previous;
        if(window.junqiExperience.restore){
          const restored=await window.junqiExperience.restore(imported);
          if(!restored.ok)throw new Error(restored.error);
          acceptSavedLearning(restored);
        }else{learning=imported;await saveExperience();}
        if(game?.result){game.skipRestoredExperience=true;persist();}
        message('已恢复电脑经验。');
      }catch(error){message('恢复经验失败：'+error.message,true);}
      finally{restoringExperience=false;render();}
    })();
  });
};
window.addEventListener('beforeunload',persist);
$('#battle-log').addEventListener('scroll',updateLogFollow);
$('#log-latest').onclick=()=>{const log=$('#battle-log');log.scrollTop=log.scrollHeight;updateLogFollow();};
window.junqiApp?.version().then(version=>{if(version)$('#app-version').textContent=`军棋 · 暗战 ${version}`;}).catch(()=>{});
initialize();
