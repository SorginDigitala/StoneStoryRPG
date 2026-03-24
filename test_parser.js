// test_parser.js — run with: node test_parser.js
// Checks parse output against expected tokens/warnings

const fs = require('fs');
const path = require('path');
const { StonescriptParser, B, T, W } = require('./StonescriptParser.js');

const api = JSON.parse(fs.readFileSync(path.join(__dirname, 'stonescript-api.json'), 'utf8'));
const p   = new StonescriptParser(api);

let passed = 0, failed = 0;

function test(name, code, checks) {
  const blocks = p.parse(code.trim());
  const html   = p.toHtml(blocks);
  const errors = [];

  for (const check of checks) {
    const result = check.fn(blocks, html);
    if (!result) errors.push(check.desc);
  }

  if (errors.length === 0) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.log(`  ✗  ${name}`);
    errors.forEach(e => console.log(`       → ${e}`));
    // Show AST for failed tests
    console.log('       AST:', JSON.stringify(blocks, null, 2).split('\n').slice(0,30).join('\n'));
    failed++;
  }
}

// Helper: find first block matching predicate (recursive)
function find(blocks, pred) {
  for (const b of blocks) {
    if (pred(b)) return b;
    const c = find(b.children, pred);
    if (c) return c;
  }
  return null;
}
function findAll(blocks, pred, acc = []) {
  for (const b of blocks) {
    if (pred(b)) acc.push(b);
    findAll(b.children, pred, acc);
  }
  return acc;
}
function hasWarning(blocks, type) {
  return findAll(blocks, b => b.warnings.some(w => w.type === type)).length > 0;
}
function htmlContains(html, str) { return html.includes(str); }

// ═══════════════════════════════════════════════════════════
console.log('\n── Token classification ──────────────────────────────');

test('command token for equipR', 'equipR ice sword D', [
  { desc: 'block type is command',
    fn: b => b[0].type === B.COMMAND },
  { desc: 'name is equipR',
    fn: b => b[0].name === 'equipR' },
  { desc: '"ice sword D" is ONE string token',
    fn: b => {
      const strTokens = b[0].tokens.filter(([t]) => t === T.STRING);
      return strTokens.length === 1 && strTokens[0][1] === 'ice sword D';
    }},
  { desc: 'html has single span.string with full arg',
    fn: (b, h) => h.includes('<span class="string">ice sword D</span>') },
]);

test('command token for equip with filters', 'equip vigor crossbow *8 +5', [
  { desc: 'block type is command', fn: b => b[0].type === B.COMMAND },
  { desc: 'arg is ONE string token (full search string)', fn: b => {
    const strs = b[0].tokens.filter(([t]) => t === T.STRING);
    return strs.length === 1 && strs[0][1] === 'vigor crossbow *8 +5';
  }},
]);

test('? condition tokens', '?foe=boss', [
  { desc: 'type is condition', fn: b => b[0].type === B.CONDITION },
  { desc: 'first token is control ?', fn: b => b[0].tokens[0][0] === T.CONTROL && b[0].tokens[0][1] === '?'},
  { desc: 'no space inserted after ?', fn: (b, h) => h.startsWith('<span class="control">?</span><span') },
  { desc: '"foe" is variable', fn: b => b[0].tokens.some(([t, v]) => t === T.VARIABLE && v === 'foe') },
]);

test(':? elseif tokens', ':?loc=deadwood', [
  { desc: 'type is elseif', fn: b => b[0].type === B.ELSEIF },
  { desc: 'first token is :?', fn: b => b[0].tokens[0][1] === ':?' },
]);

test('print prefix', '>`0,1,#red,Score', [
  { desc: 'type is print', fn: b => b[0].type === B.PRINT },
  { desc: 'print token is >`', fn: b => b[0].tokens[0][0] === T.PRINT && b[0].tokens[0][1] === '>`' },
  { desc: 'arg is single string span', fn: b => {
    const strs = b[0].tokens.filter(([t]) => t === T.STRING);
    return strs.length === 1 && strs[0][1] === '0,1,#red,Score';
  }},
]);

test('native function call', 'ambient.Stop()', [
  { desc: 'type is call', fn: b => b[0].type === B.CALL },
  { desc: 'name is ambient.Stop', fn: b => b[0].name === 'ambient.Stop' },
  { desc: 'first token is T_FUNCTION', fn: b => b[0].tokens[0][0] === T.FUNCTION },
]);

test('var keyword', 'var count = 0', [
  { desc: 'type is keyword', fn: b => b[0].type === B.KEYWORD },
  { desc: 'first token is T_KEYWORD var', fn: b => b[0].tokens[0][1] === 'var' },
]);

test('func definition', 'func RandomRange(min, max)', [
  { desc: 'type is func_def', fn: b => b[0].type === B.FUNC_DEF },
  { desc: 'has keyword token func', fn: b => b[0].tokens.some(([t, v]) => t === T.KEYWORD && v === 'func') },
  { desc: 'has identifier RandomRange', fn: b => b[0].tokens.some(([t, v]) => t === T.IDENTIFIER && v === 'RandomRange') },
]);

test('for loop', 'for i = 1..5', [
  { desc: 'type is for_loop', fn: b => b[0].type === B.FOR_LOOP },
  { desc: 'has keyword token for', fn: b => b[0].tokens[0][1] === 'for' },
]);

test('line continuation ^', '^ & time>30', [
  { desc: 'type is continuation', fn: b => b[0].type === B.CONTINUATION || b[0].type === 'continuation' },
  { desc: 'first token is continue-op', fn: b => b[0].tokens[0][0] === T.CONTINUE },
]);

test('multi-word command disable hud', 'disable hud', [
  { desc: 'type is command', fn: b => b[0].type === B.COMMAND },
  { desc: 'name is disable hud', fn: b => b[0].name === 'disable hud' },
]);

test('multi-word command disable loadout input', 'disable loadout input', [
  { desc: 'type is command', fn: b => b[0].type === B.COMMAND },
  { desc: 'name is disable loadout input', fn: b => b[0].name === 'disable loadout input' },
]);

test('assignment x++', 'count++', [
  { desc: 'type is assign', fn: b => b[0].type === B.ASSIGN },
  { desc: 'has ++ operator token', fn: b => b[0].tokens.some(([t, v]) => t === T.OPERATOR && v === '++') },
]);

test('block comment', '/* this is a comment */', [
  { desc: 'type is comment', fn: b => b[0].type === B.COMMENT },
  { desc: 'html has comment span', fn: (b, h) => htmlContains(h, 'class="comment"') },
]);

test('line comment inline', '?loc=caves // go here', [
  { desc: 'has comment token', fn: b => b[0].tokens.some(([t]) => t === T.COMMENT) },
]);

// ═══════════════════════════════════════════════════════════
console.log('\n── Indentation warnings ──────────────────────────────');

test('orphan indent → W_ORPHAN', [
  'equipL sword',
  ' equipR sword',
].join('\n'), [
  { desc: 'W_ORPHAN on second line', fn: b => hasWarning(b, W.ORPHAN) },
]);

test('inconsistent indent inside func → W_INCONSISTENT', [
  'func test3()',
  ' >"test3"',
  '   return "inconsistente"',
].join('\n'), [
  { desc: 'W_INCONSISTENT present', fn: b => hasWarning(b, W.INCONSISTENT) },
]);

test('condition children indent mismatch', [
  '?foe="boss"',
  '   equipR sword',  // sets childIndent=3
  ' activate P',      // indent=1 < 3 → pops condition frame → orphan at root
].join('\n'), [
  { desc: 'some indent warning present (orphan or inconsistent)',
    fn: b => hasWarning(b, W.ORPHAN) || hasWarning(b, W.INCONSISTENT) },
]);

test('nested indent correct — no warnings', [
  '?foe=boss & time>30',
  '  equipR sword',
  '  ?foe.state=32',
  '   activate P',
].join('\n'), [
  { desc: 'no indent warnings', fn: b =>
    !hasWarning(b, W.ORPHAN) && !hasWarning(b, W.INCONSISTENT) },
]);

test('empty func → W_EMPTY_BLOCK', [
  'func doThing()',
  '?loc=caves',
  '  loadout 1',
].join('\n'), [
  { desc: 'W_EMPTY_BLOCK on func', fn: b => hasWarning(b, W.EMPTY_BLOCK) },
  { desc: 'warning rendered as ? span (not empty span)',
    fn: (b, h) => h.includes('<span class="warning"') && !h.includes('></span>') },
]);

test('empty condition ? → W_EMPTY_EXPR', '?', [
  { desc: 'W_EMPTY_EXPR present', fn: b => hasWarning(b, W.EMPTY_EXPR) },
  { desc: '? warning shown in html as ? span',
    fn: (b, h) => htmlContains(h, '<span class="warning"') && htmlContains(h, '?</span>') },
]);

test('condition with no children → W_EMPTY_BLOCK', [
  '?foe=boss',
  'equipR sword',
].join('\n'), [
  { desc: 'W_EMPTY_BLOCK on condition', fn: b => hasWarning(b, W.EMPTY_BLOCK) },
]);

test('continuation ^ ignores indent', [
  '?foe=boss',
  '^ & time>30',
  '  equipR sword',
].join('\n'), [
  { desc: 'no ORPHAN warning', fn: b => !hasWarning(b, W.ORPHAN) },
  { desc: 'equipR is child of condition', fn: b => {
    const cond = find(b, x => x.type === B.CONDITION);
    return cond && cond.children.some(c => c.name === 'equipR');
  }},
]);

// ═══════════════════════════════════════════════════════════
console.log('\n── Warning HTML rendering ────────────────────────────');

test('orphan warning has visible text (not empty span)', [
  'equipL sword',
  ' equipR sword',
].join('\n'), [
  { desc: 'warning span has non-empty text',
    fn: (b, h) => {
      const m = h.match(/<span class="warning"[^>]*>([^<]*)<\/span>/g) || [];
      return m.some(s => {
        const inner = s.replace(/<[^>]+>/g, '');
        return inner.trim() !== '';
      });
    }},
]);

test('empty block warning has ? text', [
  '?foe=boss',
  'equipR sword',
].join('\n'), [
  { desc: 'post-warning shows ?',
    fn: (b, h) => htmlContains(h, '>?<') },
]);

// ═══════════════════════════════════════════════════════════
console.log('\n── Arg-count validation ──────────────────────────────');

test('math.Clamp with wrong arg count', 'math.Clamp(50)', [
  { desc: 'W_ARG_COUNT warning', fn: b => hasWarning(b, W.ARG_COUNT) },
]);

test('math.Clamp with correct args', 'math.Clamp(hp, 0, maxhp)', [
  { desc: 'no W_ARG_COUNT', fn: b => !hasWarning(b, W.ARG_COUNT) },
]);

test('missing arg for activate → W_BAD_FOLLOW', 'activate', [
  { desc: 'W_BAD_FOLLOW warning', fn: b => hasWarning(b, W.BAD_FOLLOW) },
]);

test('activate with arg → no warning', 'activate R', [
  { desc: 'no W_BAD_FOLLOW', fn: b => !hasWarning(b, W.BAD_FOLLOW) },
]);

// ═══════════════════════════════════════════════════════════
console.log('\n── Full example ──────────────────────────────────────');

test('full script renders without error', `
?loc=caves
  loadout 1
:?loc=deadwood
  loadout 2
:
  loadout 3
`.trim(), [
  { desc: 'else/elseif chain: 3 root blocks',  fn: b => b.length === 3 },
  { desc: 'no unexpected warnings', fn: b => {
    const all = findAll(b, x => x.warnings.length > 0);
    return all.length === 0;
  }},
]);

test('search string as single token in equip', 'equipR vigor crossbow *8 +5', [
  { desc: 'arg is ONE string token',
    fn: b => {
      const strs = b[0].tokens.filter(([t]) => t === T.STRING);
      return strs.length === 1 && strs[0][1] === 'vigor crossbow *8 +5';
    }},
]);

// ═══════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(52)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
