/* Generates lib/puzzles.js from puzzle-bank.json. Run once: node make-puzzles.js */
const fs = require('fs');
const C = require('./lib/chess-core');
const bank = JSON.parse(fs.readFileSync('puzzle-bank.json', 'utf8'));
const P = [
  { id: 'mate1', title: 'The Back-Rank Finish', difficulty: 'Beginner', rating: 850, fen: '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1', solution: 'e1e8', theme: 'Checkmate' },
  { id: 'mate2', title: 'Queen Takes Center Stage', difficulty: 'Beginner', rating: 900, fen: '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1', solution: 'g6g7', theme: 'Mate in one' },
  { id: 'mate3', title: 'A Rook\u2019s Final Word', difficulty: 'Intermediate', rating: 1050, fen: '7k/5K2/8/8/8/8/8/6R1 w - - 0 1', solution: 'g1h1', theme: 'Rook mate' },
  { id: 'mate4', title: 'One Move, Checkmate', difficulty: 'Beginner', rating: 780, fen: '7k/6pp/5K2/8/8/8/8/6R1 w - - 0 1', solution: 'g1g6', theme: 'Mate attack' }
];
const RAW = [...P, ...bank];
const valid = RAW.filter(p => {
  try {
    const s = C.parseFen(p.fen);
    const m = C.moveFromInput(s, p.solution.slice(0, 2), p.solution.slice(2, 4));
    return m && C.gameState(C.apply(s, m), {}).reason === 'Checkmate';
  } catch { return false }
});
const out = '/* Puzzle bank bundled as a module (validated at build time by make-puzzles.js). */\n' +
  'const RAW=' + JSON.stringify(valid) + ';\n' +
  'module.exports=RAW.map(({solution,...p})=>p);\n' +
  'module.exports.withSolutions=RAW;\n';
fs.writeFileSync('lib/puzzles.js', out);
console.log('lib/puzzles.js written: ' + valid.length + ' valid puzzles of ' + RAW.length + ' total');
