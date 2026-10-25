/* Knightfall chess rules core. Portable, dependency-free, server and browser. */
(function(root, factory){ if(typeof module==='object'&&module.exports)module.exports=factory();else root.ChessCore=factory(); })(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const START='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FILES='abcdefgh';
const white=p=>p&&p===p.toUpperCase(), color=p=>p?(white(p)?'w':'b'):null, opp=c=>c==='w'?'b':'w';
const rank=i=>7-Math.floor(i/8), file=i=>i%8;
const toSq=i=>FILES[file(i)]+String(rank(i)+1);
const fromSq=s=>{ if(!/^[a-h][1-8]$/.test(s||''))return -1;return (8-Number(s[1]))*8+FILES.indexOf(s[0]); };
const on=(r,c)=>r>=0&&r<8&&c>=0&&c<8;
function parseFen(fen=START){
 const fields=fen.trim().split(/\s+/);if(fields.length<4)throw Error('Invalid FEN');
 const board=[];
 for(const row of fields[0].split('/')){for(const x of row){if(/^[1-8]$/.test(x))for(let i=0;i<Number(x);i++)board.push(null);else if(/^[prnbqkPRNBQK]$/.test(x))board.push(x);else throw Error('Invalid FEN piece');}}
 if(board.length!==64||!['w','b'].includes(fields[1]))throw Error('Invalid FEN board');
 if(board.filter(x=>x==='K').length!==1||board.filter(x=>x==='k').length!==1)throw Error('Invalid kings');
 return {board,turn:fields[1],castling:fields[2]==='-'?'':fields[2],ep:fields[3]==='-'?-1:fromSq(fields[3]),half:+(fields[4]||0),full:+(fields[5]||1)};
}
function fenOf(s){let b='';for(let r=0;r<8;r++){let empty=0;for(let c=0;c<8;c++){const p=s.board[r*8+c];if(p){if(empty){b+=empty;empty=0;}b+=p;}else empty++;}if(empty)b+=empty;if(r<7)b+='/';}return [b,s.turn,s.castling||'-',s.ep<0?'-':toSq(s.ep),s.half,s.full].join(' ');}
function positionKey(s){const f=fenOf(s).split(' ');if(s.ep>=0&&!legalMoves(s).some(m=>m.enPassant))f[3]='-';return f.slice(0,4).join(' ')}
function attacked(s,square,by){const r=Math.floor(square/8),c=square%8,board=s.board;const pawn=by==='w'?'P':'p';const direction=by==='w'?1:-1;
 for(const dc of [-1,1]){let rr=r+direction,cc=c+dc;if(on(rr,cc)&&board[rr*8+cc]===pawn)return true;}
 for(const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]){const rr=r+dr,cc=c+dc;if(on(rr,cc)&&board[rr*8+cc]===(by==='w'?'N':'n'))return true;}
 for(const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]){
 let rr=r+dr,cc=c+dc,dist=1;while(on(rr,cc)){let p=board[rr*8+cc];if(p){if(color(p)===by){let t=p.toLowerCase();if(dist===1&&t==='k')return true;if((dr===0||dc===0)&&(t==='r'||t==='q'))return true;if(dr!==0&&dc!==0&&(t==='b'||t==='q'))return true;}break;}rr+=dr;cc+=dc;dist++;}}
 return false;
}
function inCheck(s,c=s.turn){let i=s.board.indexOf(c==='w'?'K':'k');return i>=0&&attacked(s,i,opp(c));}
function pseudo(s){const out=[],b=s.board,me=s.turn;
 const push=(from,to,extra={})=>{const p=b[from],target=b[to];if(target&&target.toLowerCase()==='k')return; if(target&&color(target)===me)return;const promotions=p.toLowerCase()==='p'&&(Math.floor(to/8)===0||Math.floor(to/8)===7);if(promotions){for(const promotion of ['q','r','b','n'])out.push({from,to,promotion,...extra})}else out.push({from,to,...extra});};
 for(let i=0;i<64;i++){const p=b[i];if(!p||color(p)!==me)continue;const r=Math.floor(i/8),c=i%8,t=p.toLowerCase();
 if(t==='p'){
  const d=me==='w'?-1:1,rr=r+d,start=me==='w'?6:1;
  if(on(rr,c)&&!b[rr*8+c]){push(i,rr*8+c);if(r===start&&!b[(r+2*d)*8+c])push(i,(r+2*d)*8+c);}
  for(const dc of [-1,1]){let cc=c+dc;if(on(rr,cc)){let dest=rr*8+cc;if(b[dest]&&color(b[dest])!==me)push(i,dest);else if(dest===s.ep)push(i,dest,{enPassant:true});}}
 }else if(t==='n'){
  for(const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])if(on(r+dr,c+dc))push(i,(r+dr)*8+c+dc);
 }else if(t==='b'||t==='r'||t==='q'){
  const dirs=t==='b'?[[-1,-1],[-1,1],[1,-1],[1,1]]:t==='r'?[[-1,0],[1,0],[0,-1],[0,1]]:[[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
  for(const [dr,dc] of dirs){let rr=r+dr,cc=c+dc;while(on(rr,cc)){const dest=rr*8+cc;if(b[dest]){if(color(b[dest])!==me)push(i,dest);break;}push(i,dest);rr+=dr;cc+=dc;}}
 }else if(t==='k'){
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++)if((dr||dc)&&on(r+dr,c+dc))push(i,(r+dr)*8+c+dc);
  if(!inCheck(s,me)){
   if(me==='w'&&i===60){if(s.castling.includes('K')&&b[63]==='R'&&!b[61]&&!b[62]&&!attacked(s,61,'b')&&!attacked(s,62,'b'))push(i,62,{castle:'K'});if(s.castling.includes('Q')&&b[56]==='R'&&!b[59]&&!b[58]&&!b[57]&&!attacked(s,59,'b')&&!attacked(s,58,'b'))push(i,58,{castle:'Q'});}
   if(me==='b'&&i===4){if(s.castling.includes('k')&&b[7]==='r'&&!b[5]&&!b[6]&&!attacked(s,5,'w')&&!attacked(s,6,'w'))push(i,6,{castle:'K'});if(s.castling.includes('q')&&b[0]==='r'&&!b[3]&&!b[2]&&!b[1]&&!attacked(s,3,'w')&&!attacked(s,2,'w'))push(i,2,{castle:'Q'});}
  }
 }
 }
 return out;
}
function apply(s,m){const b=s.board.slice(),p=b[m.from],captured=b[m.to];if(!p)throw Error('Missing source piece');const me=s.turn;const next={board:b,turn:opp(me),castling:s.castling,ep:-1,half:s.half+1,full:s.full+(me==='b'?1:0)};
 b[m.from]=null;b[m.to]=m.promotion?(me==='w'?m.promotion.toUpperCase():m.promotion.toLowerCase()):p;
 if(m.enPassant)b[m.to+(me==='w'?8:-8)]=null;
 if(m.castle){const kingSide=m.castle==='K',row=me==='w'?7:0,rf=row*8+(kingSide?7:0),rt=row*8+(kingSide?5:3);b[rt]=b[rf];b[rf]=null;}
 if(p==='K')next.castling=next.castling.replace(/[KQ]/g,'');if(p==='k')next.castling=next.castling.replace(/[kq]/g,'');
 if(m.from===63||m.to===63)next.castling=next.castling.replace('K','');if(m.from===56||m.to===56)next.castling=next.castling.replace('Q','');if(m.from===7||m.to===7)next.castling=next.castling.replace('k','');if(m.from===0||m.to===0)next.castling=next.castling.replace('q','');
 if(p.toLowerCase()==='p'){next.half=0;if(Math.abs(m.to-m.from)===16)next.ep=(m.to+m.from)/2;}
 if(captured||m.enPassant)next.half=0;
 return next;
}
function legalMoves(s){return pseudo(s).filter(m=>!inCheck(apply(s,m),s.turn));}
function isInsufficient(s){const pieces=s.board.filter(Boolean).filter(p=>p.toLowerCase()!=='k');if(!pieces.length)return true;if(pieces.some(p=>'pqr'.includes(p.toLowerCase())))return false;
 if(pieces.length===1)return true;
 if(pieces.length===2&&pieces.every(p=>p.toLowerCase()==='b')){const bishops=s.board.map((p,i)=>p&&p.toLowerCase()==='b'?i:-1).filter(i=>i>=0);return bishops.length===2&&((Math.floor(bishops[0]/8)+bishops[0]%8)%2===((Math.floor(bishops[1]/8)+bishops[1]%8)%2));}
 return false;
}
function gameState(s,counts={}){if(!legalMoves(s).length)return {over:true,result:inCheck(s)?(s.turn==='w'?'0-1':'1-0'):'1/2-1/2',reason:inCheck(s)?'Checkmate':'Stalemate'};
 if(isInsufficient(s))return {over:true,result:'1/2-1/2',reason:'Dead position'};
 if((counts[positionKey(s)]||0)>=5)return {over:true,result:'1/2-1/2',reason:'Fivefold repetition'};
 if(s.half>=150)return {over:true,result:'1/2-1/2',reason:'75-move rule'};
 return {over:false,check:inCheck(s),canClaimThreefold:(counts[positionKey(s)]||0)>=3,canClaimFifty:s.half>=100};}
function sanFor(s,m,legal=legalMoves(s)){if(m.castle)return m.castle==='K'?'O-O':'O-O-O';const piece=s.board[m.from],t=piece.toLowerCase(),capture=!!(s.board[m.to]||m.enPassant),end=toSq(m.to);let pref=t==='p'?'':piece.toUpperCase();
 if(t!=='p'){const alternatives=legal.filter(n=>n.to===m.to&&n.from!==m.from&&s.board[n.from]?.toLowerCase()===t);if(alternatives.length){const sameFile=alternatives.some(n=>file(n.from)===file(m.from)),sameRank=alternatives.some(n=>rank(n.from)===rank(m.from));pref+=!sameFile?FILES[file(m.from)]:!sameRank?String(rank(m.from)+1):toSq(m.from);}}
 else if(capture)pref=FILES[file(m.from)];
 let result=pref+(capture?'x':'')+end+(m.promotion?'='+m.promotion.toUpperCase():'');const next=apply(s,m);if(inCheck(next)){result+=legalMoves(next).length?'+' : '#';}return result;
}
function moveFromInput(s,from,to,promotion){const legal=legalMoves(s);const a=typeof from==='number'?from:fromSq(from),b=typeof to==='number'?to:fromSq(to);let m=legal.find(x=>x.from===a&&x.to===b&&(!x.promotion||x.promotion===(promotion||'q').toLowerCase()));if(!m)return null;return {...m,fromSquare:toSq(m.from),toSquare:toSq(m.to),san:sanFor(s,m,legal),uci:toSq(m.from)+toSq(m.to)+(m.promotion||'')};}
function fromSan(s,san){return legalMoves(s).map(m=>({...m,san:sanFor(s,m)})).find(m=>m.san.replace(/[+#?!]/g,'')===san.replace(/[+#?!]/g,''))||null;}
function moveList(fen=START,notation=[]){let s=parseFen(fen);const counts={[positionKey(s)]:1},history=[];for(const item of notation){let m=typeof item==='string'?fromSan(s,item):moveFromInput(s,item.from,item.to,item.promotion);if(!m)throw Error('Illegal move in sequence: '+JSON.stringify(item));const san=m.san||sanFor(s,m);s=apply(s,m);counts[positionKey(s)]=(counts[positionKey(s)]||0)+1;history.push({san,uci:toSq(m.from)+toSq(m.to)+(m.promotion||''),fen:fenOf(s)});}return {state:s,counts,history};}
return {START,FILES,parseFen,fenOf,positionKey,fromSq,toSq,legalMoves,moveFromInput,fromSan,apply,gameState,isInsufficient,inCheck,attacked,sanFor,moveList};
});
