// StonescriptParser.js
// Pass 1 – parse(code)  → Block[]  (AST with warnings)
// Pass 2 – toHtml(blocks) → HTML string

const B = {
  CONDITION: 'condition', ELSE: 'else', ELSEIF: 'elseif',
  COMMENT: 'comment', CONTINUE: 'continuation', COMMAND: 'command',
  PRINT: 'print', KEYWORD: 'keyword', FUNC_DEF: 'func_def',
  FOR_LOOP: 'for_loop', ASSIGN: 'assign', CALL: 'call',
  EMPTY: 'empty', RAW: 'raw',
};

const T = {
  CONTROL: 'control', COMMENT: 'comment', CONTINUE: 'continue-op',
  COMMAND: 'command', KEYWORD: 'keyword', PRINT: 'print',
  VARIABLE: 'variable', FUNCTION: 'function', OPERATOR: 'operator',
  NUMBER: 'number', STRING: 'string', IDENTIFIER: 'identifier',
  PAREN: 'paren', BRACKET: 'bracket', SPACE: 'space',
};

const W = {
  ORPHAN:       'orphan_indent',
  INCONSISTENT: 'inconsistent_indent',
  EMPTY_BLOCK:  'empty_block',
  EMPTY_EXPR:   'empty_expression',
  BAD_FOLLOW:   'invalid_follow',
  ARG_COUNT:    'wrong_arg_count',
  BAD_OPERATOR: 'invalid_operator',
  UNKNOWN_CMD:  'unknown_command',
  BAD_IMPORT:   'invalid_import',
  BAD_VAR:      'invalid_var_name',
  BAD_ACTIVATE: 'invalid_activate',
  SEALED_PROP:  'sealed_property',
  BAD_STATEMENT:'invalid_statement',
  BAD_EXPR:     'invalid_expression',
  BAD_CONTINUE: 'invalid_continuation',
};

const SCOPE_OPENERS = [B.CONDITION, B.ELSEIF, B.ELSE, B.FUNC_DEF, B.FOR_LOOP];
const TRIVIAL_TYPES = [B.EMPTY, B.CONTINUE];

// Characters never valid in a condition expression
const INVALID_EXPR_CHARS = /[;]/;

class StonescriptParser {
  constructor(api) {
    this.api        = api;
    this.byId       = {};
    this.commands   = [];
    this.multiCmds  = [];
    this.keywords   = [];       // lowercase keyword ids
    this.keywordSet = new Set();
    this.varRoots   = [];
    this.printPfx   = ['>o', '>h', ">'", '>c', '>f', '>(', '>'];
    this.operators  = [':?','>=','<=','!=','++','--','=','!','&','|','>','<','+','-','*','/','%'];
    this.enumValues = {};

    // Loaded from __validation__ meta entry
    this.sealedGroups            = new Set();
    this.reservedNames           = new Set();
    this.validAbilityIds         = new Set();
    this.continuationStartsWith  = new Set();
    this.keywordsNotInExpr       = new Set();
    this.validConditionOps       = new Set(['=','!','&','|','>','<','>=','<=']);

    // Loaded from ?.validate
    this.condValidate = {};
    // Loaded from import.validate
    this.importValidate = {};
    // Loaded from var.validate
    this.varValidate = {};

    this._buildIndex();
  }

  _buildIndex() {
    const singleCmds = [];
    for (const e of this.api) {
      this.byId[e.id] = e;
      switch (e.type) {
        case 'command':
          e.id.includes(' ') ? this.multiCmds.push(e.id) : singleCmds.push(e.id.toLowerCase());
          break;
        case 'keyword':
          this.keywords.push(e.id.toLowerCase());
          this.keywordSet.add(e.id.toLowerCase());
          break;
        case 'var':
        case 'func': {
          const root = e.id.split('.')[0];
          if (root && !this.varRoots.includes(root)) this.varRoots.push(root);
          break;
        }
        case 'enum':
          this.enumValues[e.id] = e.values || [];
          break;
        case 'meta':
          if (e.id === '__validation__') {
            this.sealedGroups           = new Set(e.sealed_groups              || []);
            this.reservedNames          = new Set(e.reserved_var_names         || []);
            this.validAbilityIds        = new Set(e.valid_ability_ids          || []);
            this.continuationStartsWith = new Set(e.continuation_must_start_with || []);
            this.keywordsNotInExpr      = new Set(e.keywords_not_allowed_in_expr || []);
          }
          break;
      }
    }
    this.commands = singleCmds;
    this.multiCmds.sort((a, b) => b.length - a.length);
    this.printPfx = ['>o', '>h', '>`', '>c', '>f', '>(', '>'];

    // Cache validate objects from JSON entries
    if (this.byId['?'])      this.condValidate   = this.byId['?'].validate   || {};
    if (this.byId['import']) this.importValidate = this.byId['import'].validate || {};
    if (this.byId['var'])    this.varValidate    = this.byId['var'].validate  || {};

    // Load activate validation from activate.arg_validation (data-driven)
    const av = (this.byId['activate'] && this.byId['activate'].arg_validation) || {};
    this.abilityFixed   = new Set((av.fixed_values      || []).map(v => v.toLowerCase()));
    this.abilityKnown   = new Set((av.known_ability_ids || []).map(v => v.toLowerCase()));
    this.abilityCharset = av.charset ? new RegExp(av.charset) : /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    this.validAbilityIds = new Set([...this.abilityFixed, ...this.abilityKnown]);
  }

  // ── PUBLIC API ────────────────────────────────────────────
  format(code) { return this.toHtml(this.parse(code)); }
  parse(code) {
    const lines = this._splitLines(code);
    const flat  = lines.map(l => this._parseLine(l));
    return this._buildTree(flat);
  }
  toHtml(blocks) { return blocks.map(b => this._blockToHtml(b)).join('\n'); }

  // ── PASS 1A: LINE SPLITTING ───────────────────────────────
  _splitLines(code) {
    const lines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.includes('/*') && this._findCommentClose(line) === -1) {
        let collected = line; i++;
        while (i < lines.length) {
          collected += '\n' + lines[i];
          if (this._findCommentClose(lines[i]) !== -1) { i++; break; }
          i++;
        }
        out.push(collected);
      } else { out.push(line); i++; }
    }
    return out;
  }

  _findCommentClose(s) {
    let pos = 0;
    while (true) {
      const idx = s.indexOf('*/', pos);
      if (idx === -1) return -1;
      if (idx > 0 && s[idx - 1] === '\\') { pos = idx + 2; continue; }
      return idx;
    }
  }

  // ── PASS 1B: LINE PARSER ──────────────────────────────────
  _parseLine(rawLine) {
    if (rawLine.includes('\n')) {
      const indent = this._leadingSpaces(rawLine);
      const content = rawLine.trimStart();
      return this._block(B.COMMENT, indent, content, [[T.COMMENT, content]]);
    }
    const indent  = this._leadingSpaces(rawLine);
    const content = rawLine.slice(indent);
    if (content === '' || content.trim() === '') return this._block(B.EMPTY, indent, '', []);

    // ^ continuation
    if (content[0] === '^') {
      const rest     = content.slice(1).trimStart();
      const tokens   = [[T.CONTINUE, '^'], ...this._tokenizeExpr(content.slice(1))];
      const warnings = this._checkContinuation(rest);
      return this._block(B.CONTINUE, indent, content, tokens, { warnings });
    }

    if (content.startsWith('/*') && this._findCommentClose(content) !== -1)
      return this._block(B.COMMENT, indent, content, [[T.COMMENT, content]]);
    if (content.startsWith('//'))
      return this._block(B.COMMENT, indent, content, [[T.COMMENT, content]]);

    // :? elseif
    if (content.startsWith(':?')) {
      const after = content.slice(2), expr = after.trimStart();
      const warnings = [
        ...(expr === '' ? [this._warn(W.EMPTY_EXPR, 'La condicion :? esta vacia')] : []),
        ...this._checkConditionExpr(expr),
      ];
      return this._block(B.ELSEIF, indent, content,
        [[T.CONTROL, ':?'], ...this._tokenizeExpr(after)], { value: expr, warnings });
    }

    // : else
    if (content === ':') return this._block(B.ELSE, indent, content, [[T.CONTROL, ':']]);

    // ? condition
    if (content[0] === '?') {
      const after = content.slice(1), expr = after.trimStart();
      const warnings = [
        ...(expr === '' ? [this._warn(W.EMPTY_EXPR, 'La condicion ? esta vacia')] : []),
        ...this._checkConditionExpr(expr),
      ];
      return this._block(B.CONDITION, indent, content,
        [[T.CONTROL, '?'], ...this._tokenizeExpr(after)], { value: expr, warnings });
    }

    // Print prefixes
    for (const pfx of this.printPfx) {
      if (content.startsWith(pfx)) {
        const arg    = content.slice(pfx.length);
        const tokens = [[T.PRINT, pfx]];
        if (arg !== '') tokens.push([T.STRING, arg]);
        return this._block(B.PRINT, indent, content, tokens,
          { name: pfx, value: arg, def: this.byId[pfx] || null });
      }
    }

    // Multi-word commands
    const lcContent = content.toLowerCase();
    for (const mc of this.multiCmds) {
      if (lcContent.startsWith(mc.toLowerCase())) {
        const rest = content.slice(mc.length), arg = rest.trimStart();
        const def  = this.byId[mc] || null;
        const warnings = this._checkFollow(def, arg);
        const tokens   = [[T.COMMAND, content.slice(0, mc.length)]];
        if (arg !== '') { tokens.push([T.SPACE, ' ']); tokens.push(...this._tokenizeArg(arg, def)); }
        return this._block(B.COMMAND, indent, content, tokens, { name: mc, value: arg, def, warnings });
      }
    }

    if (/^[a-zA-Z_]/.test(content)) return this._parseWordLine(indent, content);
    return this._block(B.RAW, indent, content, this._tokenizeExpr(content));
  }

  _parseWordLine(indent, content) {
    const m = content.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)(.*)$/s);
    const word = m[1], rest = m[2] || '', lc = word.toLowerCase();

    if (lc === 'func') {
      const sig = rest.trimStart();
      return this._block(B.FUNC_DEF, indent, content,
        [[T.KEYWORD, 'func'], [T.SPACE, ' '], ...this._tokenizeFuncSig(sig)],
        { name: 'func', value: sig });
    }
    if (lc === 'for') {
      const expr = rest.trimStart();
      return this._block(B.FOR_LOOP, indent, content,
        [[T.KEYWORD, 'for'], [T.SPACE, ' '], ...this._tokenizeExpr(expr)],
        { name: 'for', value: expr });
    }
    if (this.keywords.includes(lc)) {
      const arg = rest.trimStart(), def = this.byId[lc] || null;
      const tokens = [[T.KEYWORD, word]];
      if (arg !== '') { tokens.push([T.SPACE, ' ']); tokens.push(...this._tokenizeExpr(arg)); }
      const warnings = this._checkKeyword(lc, arg, def);
      return this._block(B.KEYWORD, indent, content, tokens, { name: word, value: arg, def, warnings });
    }
    if (this.commands.includes(lc)) {
      const arg = rest.trimStart(), def = this._lookupCommand(word);
      const warnings = [...this._checkFollow(def, arg), ...this._checkCommand(lc, arg, def)];
      const tokens   = [[T.COMMAND, word]];
      if (arg !== '') { tokens.push([T.SPACE, ' ']); tokens.push(...this._tokenizeArg(arg, def)); }
      return this._block(B.COMMAND, indent, content, tokens, { name: word, value: arg, def, warnings });
    }
    if (rest.trimStart().startsWith('(')) return this._parseFuncCall(indent, content, word, rest.trimStart());
    if (/^\s*[+\-*\/]?=/.test(rest) || rest.trimStart().startsWith('++') || rest.trimStart().startsWith('--')) {
      const tokens = [...this._resolveIdentToken(word), ...this._tokenizeExpr(rest)];
      return this._block(B.ASSIGN, indent, content, tokens, { name: word, value: rest.trim() });
    }

    // Bare word: Rule 3 (bad statement) + Rule 7 (sealed prop)
    const warnings = this._checkBareWord(word, rest);
    const tokens   = [...this._resolveIdentToken(word), ...this._tokenizeExpr(rest)];
    return this._block(B.RAW, indent, content, tokens, { name: word, warnings });
  }

  _parseFuncCall(indent, content, name, rest) {
    const def      = this._lookupFuncOrVar(name);
    const tokens   = [...this._resolveIdentToken(name), ...this._tokenizeCallArgs(rest, def)];
    const warnings = [
      ...((def && def.args && !def.overloads) ? this._checkArgCount(def, rest) : []),
      ...this._checkSealedProp(name),
    ];
    return this._block(B.CALL, indent, content, tokens, { name, value: rest, def, warnings });
  }

  // ── PASS 1C: TREE BUILDER ─────────────────────────────────
  _buildTree(flat) {
    const blocks = flat.map(b => ({ ...b, children: [], warnings: [...b.warnings] }));
    const n      = blocks.length;
    const stack  = [{ blockIdx: null, childIndent: null, parentIndent: -1 }];
    for (let bi = 0; bi < n; bi++) {
      const type    = blocks[bi].type;
      const indent  = blocks[bi].indent;
      const trivial = TRIVIAL_TYPES.includes(type);
      if (!trivial) {
        while (stack.length > 1) {
          const top = stack[stack.length - 1];
          if (top.childIndent === null && indent > top.parentIndent) break;
          if (top.childIndent !== null && indent === top.childIndent) break;
          if (top.childIndent !== null && indent > top.childIndent) break;
          if (top.childIndent === null && top.blockIdx !== null)
            blocks[top.blockIdx].warnings.push(
              this._warn(W.EMPTY_BLOCK, 'El bloque esta vacio (no hay lineas con mayor indentacion)'));
          stack.pop();
        }
        const top = stack[stack.length - 1], si = stack.length - 1;
        if (si === 0 && indent > 0)
          blocks[bi].warnings.push(this._warn(W.ORPHAN, 'Espaciado inconsistente: no hay condicion ni funcion padre'));
        else if (top.childIndent === null) stack[si].childIndent = indent;
        else if (indent !== top.childIndent)
          blocks[bi].warnings.push(this._warn(W.INCONSISTENT,
            `El espaciado no coincide con la linea anterior (esperado ${top.childIndent}, encontrado ${indent})`));
      }
      const top = stack[stack.length - 1];
      if (top.blockIdx !== null) blocks[top.blockIdx].children.push(bi);
      if (!trivial && SCOPE_OPENERS.includes(type))
        stack.push({ blockIdx: bi, childIndent: null, parentIndent: indent });
    }
    for (let i = stack.length - 1; i >= 1; i--) {
      const f = stack[i];
      if (f.childIndent === null && f.blockIdx !== null)
        blocks[f.blockIdx].warnings.push(
          this._warn(W.EMPTY_BLOCK, 'El bloque esta vacio (no hay lineas con mayor indentacion)'));
    }
    return this._resolveTree(blocks);
  }

  _resolveTree(blocks) {
    const childSet = new Set();
    for (const b of blocks) for (const ci of b.children) childSet.add(ci);
    const result = [];
    for (let i = 0; i < blocks.length; i++)
      if (!childSet.has(i)) result.push(this._nestBlock(blocks, i));
    return result;
  }
  _nestBlock(blocks, idx) {
    const b = { ...blocks[idx] };
    b.children = b.children.map(ci => this._nestBlock(blocks, ci));
    return b;
  }

  // ── TOKENIZERS ────────────────────────────────────────────
  _tokenizeExpr(expr) {
    const tokens = []; let pos = 0;
    while (pos < expr.length) {
      const rest = expr.slice(pos), c = rest[0];
      if (rest.startsWith('//')) { tokens.push([T.COMMENT, rest]); break; }
      if (rest.startsWith('/*')) {
        const close = this._findCommentClose(rest);
        const val   = close !== -1 ? rest.slice(0, close + 2) : rest;
        tokens.push([T.COMMENT, val]); pos += val.length; continue;
      }
      if (c === ' ' || c === '\t') {
        let ws = '';
        while (pos < expr.length && (expr[pos] === ' ' || expr[pos] === '\t')) ws += expr[pos++];
        tokens.push([T.SPACE, ws]); continue;
      }
      if (c === '@') {
        const end = expr.indexOf('@', pos + 1);
        if (end !== -1) { tokens.push([T.IDENTIFIER, expr.slice(pos, end + 1)]); pos = end + 1; }
        else            { tokens.push([T.IDENTIFIER, rest]); pos = expr.length; }
        continue;
      }
      if (c === '"') {
        const end = expr.indexOf('"', pos + 1);
        if (end !== -1) { tokens.push([T.STRING, expr.slice(pos, end + 1)]); pos = end + 1; }
        else            { tokens.push([T.STRING, rest]); pos = expr.length; }
        continue;
      }
      let matched = false;
      for (const op of this.operators) {
        if (op === ':?') continue;
        if (rest.startsWith(op)) { tokens.push([T.OPERATOR, op]); pos += op.length; matched = true; break; }
      }
      if (matched) continue;
      if ('()'.includes(c)) { tokens.push([T.PAREN, c]);   pos++; continue; }
      if ('[]'.includes(c)) { tokens.push([T.BRACKET, c]); pos++; continue; }
      if (/\d/.test(c) || (c === '-' && pos + 1 < expr.length && /\d/.test(expr[pos + 1]))) {
        const nm = rest.match(/^-?\d+(\.\d+)?/);
        tokens.push([T.NUMBER, nm[0]]); pos += nm[0].length; continue;
      }
      if (/[a-zA-Z_]/.test(c)) {
        const wm = rest.match(/^[a-zA-Z_][a-zA-Z0-9_.]*/), word = wm[0];
        pos += word.length;
        if (pos < expr.length && expr[pos] === '(') {
          const def = this._lookupFuncOrVar(word);
          tokens.push([(def && def.type === 'func') ? T.FUNCTION : T.IDENTIFIER, word]);
          let depth = 1, inner = '('; pos++;
          while (pos < expr.length && depth > 0) {
            const ch = expr[pos]; inner += ch;
            if (ch === '(') depth++; else if (ch === ')') depth--;
            pos++;
          }
          tokens.push(...this._tokenizeCallArgs(inner, def)); continue;
        }
        tokens.push(...this._resolveIdentToken(word)); continue;
      }
      tokens.push([T.STRING, c]); pos++;
    }
    return tokens;
  }

  _tokenizeCallArgs(callStr, def) {
    const s = callStr.trimStart();
    if (!s.startsWith('(')) return this._tokenizeExpr(callStr);
    const tokens = [[T.PAREN, '(']];
    let depth = 1, inner = '', i = 1;
    while (i < s.length && depth > 0) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
      inner += ch; i++;
    }
    if (inner !== '') tokens.push(...this._tokenizeExpr(inner));
    tokens.push([T.PAREN, ')']);
    const after = s.slice(i);
    if (after.trim() !== '') tokens.push(...this._tokenizeExpr(after));
    return tokens;
  }

  _tokenizeArg(arg, def) {
    const follows = def && def.follows ? def.follows : '';
    switch (follows) {
      case 'number': case 'expr': return this._tokenizeExpr(arg);
      case 'search_string':       return [[T.STRING, arg]];
      case 'func_signature':      return this._tokenizeFuncSig(arg);
      case 'ability_id': case 'sound_id': return [[T.IDENTIFIER, arg]];
      default: return [[T.STRING, arg]];
    }
  }

  _tokenizeFuncSig(sig) {
    const m = sig.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)(\(.*\))?$/);
    if (!m) return [[T.IDENTIFIER, sig]];
    const tokens = [[T.IDENTIFIER, m[1]]];
    if (m[2]) {
      const inner = m[2].slice(1, -1);
      tokens.push([T.PAREN, '(']);
      inner.split(',').map(p => p.trim()).forEach((p, j) => {
        if (j) { tokens.push([T.STRING, ',']); tokens.push([T.SPACE, ' ']); }
        if (p) tokens.push([T.IDENTIFIER, p]);
      });
      tokens.push([T.PAREN, ')']);
    }
    return tokens;
  }

  // ── LOOKUP HELPERS ────────────────────────────────────────
  _resolveIdentToken(word) {
    const def = this._lookupFuncOrVar(word);
    if (def) return [[(def.type === 'func' ? T.FUNCTION : T.VARIABLE), word]];
    const root = word.split('.')[0];
    if (this.varRoots.includes(root)) return [[T.VARIABLE, word]];
    return [[T.IDENTIFIER, word]];
  }
  _lookupFuncOrVar(name) {
    if (this.byId[name]) return this.byId[name];
    const bare = name.replace(/\(.*$/s, '');
    if (this.byId[bare]) return this.byId[bare];
    return null;
  }
  _lookupCommand(name) {
    const lc = name.toLowerCase();
    return this.api.find(e => e.type === 'command' && e.id.toLowerCase() === lc) || null;
  }

  // ── VALIDATION (data-driven) ──────────────────────────────

  // Rule 1+2: condition expression validation
  // Uses condValidate loaded from ?.validate in JSON
  _checkConditionExpr(expr) {
    if (!expr) return [];
    const warns = [];

    // Semicolons (and other explicitly invalid chars)
    if (INVALID_EXPR_CHARS.test(expr))
      warns.push(this._warn(W.BAD_EXPR,
        `Caracter invalido en la expresion: '${expr.match(INVALID_EXPR_CHARS)[0]}'. ` +
        `Las condiciones no admiten ';'. Usa '&' para combinar condiciones.`));

    // Double/invalid operator sequences (==, =!, !!, =<, etc.)
    // Read valid ops from the JSON condValidate if available
    const doubleOps = expr.match(/[=!<>]{2,}/g);
    if (doubleOps) {
      for (const seq of doubleOps) {
        if (!this.validConditionOps.has(seq))
          warns.push(this._warn(W.BAD_OPERATOR,
            `Operador invalido: '${seq}'. Operadores validos: = ! < > <= >= & |`));
      }
    }

    // Embedded ? (condition inside expression: ?klk?manin)
    // JSON: condValidate.no_embedded_condition
    if (this.condValidate.no_embedded_condition && expr.includes('?'))
      warns.push(this._warn(W.BAD_EXPR,
        `'?' no puede aparecer dentro de una expresion de condicion.`));

    // Keywords as operands (var, func, return…)
    // JSON: condValidate.no_keywords_as_operands + __validation__.keywords_not_allowed_in_expr
    if (this.condValidate.no_keywords_as_operands && this.keywordsNotInExpr.size) {
      // Tokenize the expression and look for keyword-type identifiers
      const words = expr.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
      for (const w of words) {
        if (this.keywordsNotInExpr.has(w.toLowerCase()))
          warns.push(this._warn(W.BAD_EXPR,
            `'${w}' es una palabra reservada y no puede usarse como operando en una condicion.`));
      }
    }

    // Bare string without operator (e.g. ?foe "skeleton")
    // JSON: condValidate.no_bare_string
    if (this.condValidate.no_bare_string) {
      // Detect: identifier/variable followed directly by a quoted string with no operator between
      if (/[a-zA-Z0-9_]\s+"/.test(expr) || /[a-zA-Z0-9_]\s+'/.test(expr))
        warns.push(this._warn(W.BAD_EXPR,
          `String literal sin operador. Usa un operador de comparacion: = ! < > <= >=`));
    }

    // Sealed property access inside the expression (e.g. ?foe.test>0)
    // Walk all dotted words in the expression
    const dottedWords = expr.match(/\b[a-zA-Z_][a-zA-Z0-9_.]*\b/g) || [];
    for (const dw of dottedWords) {
      if (!dw.includes('.')) continue;
      const sealedWarns = this._checkSealedProp(dw);
      warns.push(...sealedWarns);
    }

    return warns;
  }

  // Rule: continuation (^) must start with & | ( .
  // JSON: __validation__.continuation_must_start_with
  _checkContinuation(rest) {
    if (!rest || !this.continuationStartsWith.size) return [];
    const first = rest[0];
    if ([...this.continuationStartsWith].some(s => rest.startsWith(s))) return [];
    return [this._warn(W.BAD_CONTINUE,
      `Una linea de continuacion ^ debe empezar con & o | (conector logico) ` +
      `o con ( o . (continuacion de expresion). ` +
      `Se encontro: '${rest.slice(0, 10)}'`)];
  }

  // Rule 3 + 7: bare identifier on its own line
  _checkBareWord(word, rest) {
    const sealedWarn = this._checkSealedProp(word);
    if (sealedWarn.length) return sealedWarn;
    if (rest.trim() !== '') return [];
    const def      = this._lookupFuncOrVar(word);
    const root     = word.split('.')[0];
    const isNative = def || this.varRoots.includes(root);
    if (isNative)
      return [this._warn(W.BAD_STATEMENT,
        `'${word}' es una variable/funcion nativa pero no es un statement valido. ` +
        `Usala en una condicion (?${word}) o asignacion (var x = ${word}).`)];
    return [this._warn(W.UNKNOWN_CMD,
      `'${word}' no es un comando, variable ni funcion reconocida.`)];
  }

  // Rule 7: sealed group property check
  _checkSealedProp(name) {
    if (!name.includes('.')) return [];
    const root = name.split('.')[0];
    if (!this.sealedGroups.has(root)) return [];
    if (this.byId[name]) return [];
    const bare = name.replace(/\(.*$/s, '');
    if (this.byId[bare]) return [];
    const known = this.api.some(e => (e.type === 'var' || e.type === 'func') && e.id === name);
    if (known) return [];
    return [this._warn(W.SEALED_PROP,
      `'${name}' no existe. '${root}' es una variable nativa sellada — ` +
      `sus propiedades estan fijadas por el juego.`)];
  }

  // Rule 4: import validation — reads from importValidate (JSON)
  _checkImport(path) {
    if (!path.trim()) return [];
    const warns = [];
    if (this.importValidate.no_spaces && /\s/.test(path))
      warns.push(this._warn(W.BAD_IMPORT,
        `La ruta '${path}' no puede contener espacios.`));
    else if (this.importValidate.pattern) {
      const re = new RegExp(this.importValidate.pattern);
      if (!re.test(path))
        warns.push(this._warn(W.BAD_IMPORT,
          `La ruta '${path}' contiene caracteres no validos. ` +
          (this.importValidate.pattern_desc || `Solo se permiten letras a-z A-Z, digitos 0-9, /, _, . y -`)));
    }
    return warns;
  }

  // Rule 5: var declaration validation — reads from varValidate (JSON)
  _checkVarDecl(arg) {
    if (!arg.trim()) return [];
    const nameMatch = arg.trim().match(/^([^\s=]+)/);
    if (!nameMatch) return [];
    const name = nameMatch[1];

    if (/,/.test(name) || /\s/.test(arg.trim().replace(/\s*=.*/, '')))
      return [this._warn(W.BAD_VAR,
        `Solo se puede declarar una variable a la vez. Usa una linea 'var' por variable.`)];

    // Validate with pattern from JSON
    const pattern = this.varValidate.identifier_pattern || '^[a-zA-Z_][a-zA-Z0-9_]*$';
    if (!new RegExp(pattern).test(name))
      return [this._warn(W.BAD_VAR,
        `'${name}' no es un nombre de variable valido. ` +
        `Debe empezar por letra o _ y solo contener letras a-z A-Z, digitos 0-9 y _.`)];

    // Check reserved names from JSON
    if (this.reservedNames.has(name))
      return [this._warn(W.BAD_VAR,
        `'${name}' es una variable nativa del juego y no puede usarse como nombre de variable.`)];

    return [];
  }

  // Rule 6: activate — data-driven from activate.arg_validation in JSON
  // fixed_values: always valid (l/r/p/left/right/potion)
  // known_ability_ids: known item ability ids (bardiche, bash...)
  // charset: what chars are allowed at all
  _checkActivate(arg) {
    if (!arg.trim()) return [];
    const val = arg.trim();
    const lc  = val.toLowerCase();

    // Multi-word: never valid
    if (/\s/.test(val))
      return [this._warn(W.BAD_ACTIVATE,
        `'${val}' no puede contener espacios. ` +
        `Fijos validos: ${[...this.abilityFixed].join(', ')}.`)];

    // Charset check (from activate.arg_validation.charset in JSON)
    if (!this.abilityCharset.test(val))
      return [this._warn(W.BAD_ACTIVATE,
        `'${val}' contiene caracteres no validos. ` +
        `Solo se permiten letras a-z A-Z, digitos y _.`)];

    // Fixed values are always valid (case-insensitive)
    if (this.abilityFixed.has(lc)) return [];

    // Known ability IDs are valid
    if (this.abilityKnown.has(lc)) return [];

    // Unknown — report error with both lists
    const all = [...this.abilityFixed, ...this.abilityKnown].sort();
    return [this._warn(W.BAD_ACTIVATE,
      `'${val}' no es un ability ID reconocido. ` +
      `Fijos: ${[...this.abilityFixed].join(', ')}. ` +
      `Conocidos: ${[...this.abilityKnown].join(', ')}.`)];
  }

  // Dispatch keyword validations
  _checkKeyword(lc, arg, def) {
    if (lc === 'import') return this._checkImport(arg);
    if (lc === 'var')    return this._checkVarDecl(arg);
    return [];
  }
  _checkCommand(lc, arg, def) {
    if (lc === 'activate') return this._checkActivate(arg);
    return [];
  }

  // ── LEGACY VALIDATION ─────────────────────────────────────
  _checkFollow(def, arg) {
    if (!def || !def.follows) return [];
    if (arg.trim() !== '') return [];
    const args     = def.args || [];
    const required = args.length === 0 ? 1 : args.filter(a => !a.optional).length;
    if (!required) return [];
    return [this._warn(W.BAD_FOLLOW, `'${def.id}' requiere un argumento (${def.follows})`)];
  }
  _checkArgCount(def, callStr) {
    const m = callStr.trim().match(/^\((.*)\)$/s);
    if (!m) return [];
    const inner    = m[1].trim();
    const count    = inner === '' ? 0 : inner.split(/,(?![^(]*\))/).length;
    const args     = def.args || [];
    const required = args.filter(a => !a.optional).length;
    const total    = args.length;
    if (count < required || count > total)
      return [this._warn(W.ARG_COUNT,
        `'${def.id}' espera entre ${required} y ${total} argumento(s), se encontraron ${count}`)];
    return [];
  }

  // ── PASS 2: HTML RENDERER ─────────────────────────────────
  _blockToHtml(block, depth = 0) {
    if (block.type === B.EMPTY) return '';
    const indent    = ' '.repeat(block.indent);
    const preWarns  = block.warnings
      .filter(w => w.type !== W.EMPTY_EXPR && w.type !== W.EMPTY_BLOCK)
      .map(w => this._warnSpan('⚠', w.message)).join('');
    const postWarns = block.warnings
      .filter(w => w.type === W.EMPTY_EXPR || w.type === W.EMPTY_BLOCK)
      .map(w => this._warnSpan('?', w.message)).join('');
    let html = indent + preWarns + this._renderTokens(block.tokens) + postWarns;
    for (const child of block.children) {
      const ch = this._blockToHtml(child, depth + 1);
      if (ch !== '') html += '\n' + ch;
    }
    return html;
  }
  _renderTokens(tokens) {
    return tokens.map(([type, value]) =>
      type === T.SPACE ? this._esc(value || ' ') : `<span class="${type}">${this._esc(value)}</span>`
    ).join('');
  }
  _warnSpan(text, msg) {
    return `<span class="warning" data-warning="${this._esc(msg)}">${this._esc(text)}</span>`;
  }
  _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── UTILITIES ─────────────────────────────────────────────
  _block(type, indent, raw, tokens, extra = {}) {
    return { type, indent, raw, tokens, def: null, name: null, value: null,
             children: [], warnings: [], ...extra };
  }
  _warn(type, message) { return { type, message }; }
  _leadingSpaces(line) {
    let i = 0;
    while (i < line.length && line[i] === ' ') i++;
    return i;
  }
}

if (typeof module !== 'undefined') module.exports = { StonescriptParser, B, T, W };
