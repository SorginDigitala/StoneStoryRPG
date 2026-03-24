// StonescriptParser.js
// Pass 1 – parse(code)  → Block[]  (AST with warnings)
// Pass 2 – toHtml(blocks) → HTML string
//
// Block: { type, indent, raw, tokens, def, name, value, children[], warnings[] }
// Token: [type, value]

const B = {
  CONDITION: 'condition',
  ELSE:      'else',
  ELSEIF:    'elseif',
  COMMENT:   'comment',
  CONTINUE:  'continuation',
  COMMAND:   'command',
  PRINT:     'print',
  KEYWORD:   'keyword',
  FUNC_DEF:  'func_def',
  FOR_LOOP:  'for_loop',
  ASSIGN:    'assign',
  CALL:      'call',
  EMPTY:     'empty',
  RAW:       'raw',
};

const T = {
  CONTROL:    'control',
  COMMENT:    'comment',
  CONTINUE:   'continue-op',
  COMMAND:    'command',
  KEYWORD:    'keyword',
  PRINT:      'print',
  VARIABLE:   'variable',
  FUNCTION:   'function',
  OPERATOR:   'operator',
  NUMBER:     'number',
  STRING:     'string',
  IDENTIFIER: 'identifier',
  PAREN:      'paren',
  BRACKET:    'bracket',
  SPACE:      'space',
};

const W = {
  ORPHAN:       'orphan_indent',
  INCONSISTENT: 'inconsistent_indent',
  EMPTY_BLOCK:  'empty_block',
  EMPTY_EXPR:   'empty_expression',
  BAD_FOLLOW:   'invalid_follow',
  ARG_COUNT:    'wrong_arg_count',
};

const SCOPE_OPENERS = [B.CONDITION, B.ELSEIF, B.ELSE, B.FUNC_DEF, B.FOR_LOOP];
const TRIVIAL_TYPES = [B.EMPTY, B.CONTINUE];

class StonescriptParser {
  constructor(api) {
    this.api        = api;
    this.byId       = {};
    this.commands   = [];   // lowercase single-word command ids
    this.multiCmds  = [];   // multi-word command ids, longest first
    this.keywords   = [];
    this.varRoots   = [];
    this.printPfx   = ['>o', '>h', '>\'', '>c', '>f', '>(', '>'];  // longest first; backtick variant added below
    this.operators  = [':?','>=','<=','!=','++','--','=','!','&','|','>','<','+','-','*','/','%'];
    this.enumValues = {};
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
      }
    }
    this.commands = singleCmds;
    this.multiCmds.sort((a, b) => b.length - a.length);
    // Print prefixes longest first (backtick variant)
    this.printPfx = ['>o', '>h', '>`', '>c', '>f', '>(', '>'];
  }

  // =========================================================
  // PUBLIC API
  // =========================================================

  format(code) { return this.toHtml(this.parse(code)); }

  parse(code) {
    const lines = this._splitLines(code);
    const flat  = lines.map(l => this._parseLine(l));
    return this._buildTree(flat);
  }

  toHtml(blocks) {
    return blocks.map((b, i) => this._blockToHtml(b)).join('\n');
  }

  // =========================================================
  // PASS 1A — LINE SPLITTING
  // =========================================================

  _splitLines(code) {
    const lines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out   = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const opensBlock  = line.includes('/*');
      const closesBlock = this._findCommentClose(line) !== -1;
      if (opensBlock && !closesBlock) {
        let collected = line;
        i++;
        while (i < lines.length) {
          collected += '\n' + lines[i];
          if (this._findCommentClose(lines[i]) !== -1) { i++; break; }
          i++;
        }
        out.push(collected);
      } else {
        out.push(line);
        i++;
      }
    }
    return out;
  }

  // Returns index of unescaped */ or -1. Escaped form is *\/
  _findCommentClose(s) {
    let pos = 0;
    while (true) {
      const idx = s.indexOf('*/', pos);
      if (idx === -1) return -1;
      if (idx > 0 && s[idx - 1] === '\\') { pos = idx + 2; continue; }
      return idx;
    }
  }

  // =========================================================
  // PASS 1B — LINE PARSER
  // =========================================================

  _parseLine(rawLine) {
    // Multi-line collapsed block comment
    if (rawLine.includes('\n')) {
      const indent  = this._leadingSpaces(rawLine);
      const content = rawLine.trimStart();
      return this._block(B.COMMENT, indent, content, [[T.COMMENT, content]]);
    }

    const indent  = this._leadingSpaces(rawLine);
    const content = rawLine.slice(indent);

    if (content === '')
      return this._block(B.EMPTY, indent, '', []);

    // ^ line continuation
    if (content[0] === '^') {
      const rest   = content.slice(1);
      const tokens = [[T.CONTINUE, '^'], ...this._tokenizeExpr(rest)];
      return this._block(B.CONTINUE, indent, content, tokens);
    }

    // Single-line block comment
    if (content.startsWith('/*') && this._findCommentClose(content) !== -1)
      return this._block(B.COMMENT, indent, content, [[T.COMMENT, content]]);

    // Line comment
    if (content.startsWith('//'))
      return this._block(B.COMMENT, indent, content, [[T.COMMENT, content]]);

    // :? elseif
    if (content.startsWith(':?')) {
      const after    = content.slice(2);
      const expr     = after.trimStart();
      const warnings = expr === '' ? [this._warn(W.EMPTY_EXPR, 'La condicion :? esta vacia')] : [];
      return this._block(B.ELSEIF, indent, content,
        [[T.CONTROL, ':?'], ...this._tokenizeExpr(after)],
        { value: expr, warnings });
    }

    // : else
    if (content === ':')
      return this._block(B.ELSE, indent, content, [[T.CONTROL, ':']]);

    // ? condition
    if (content[0] === '?') {
      const after    = content.slice(1);
      const expr     = after.trimStart();
      const warnings = expr === '' ? [this._warn(W.EMPTY_EXPR, 'La condicion ? esta vacia')] : [];
      return this._block(B.CONDITION, indent, content,
        [[T.CONTROL, '?'], ...this._tokenizeExpr(after)],
        { value: expr, warnings });
    }

    // Print prefixes
    for (const pfx of this.printPfx) {
      if (content.startsWith(pfx)) {
        const arg = content.slice(pfx.length);
        // arg is a single string — one span
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
        const rest     = content.slice(mc.length);
        const arg      = rest.trimStart();
        const def      = this.byId[mc] || null;
        const warnings = this._checkFollow(def, arg);
        // command token uses exact casing from input
        const tokens   = [[T.COMMAND, content.slice(0, mc.length)]];
        if (arg !== '') {
          tokens.push([T.SPACE, ' ']);
          tokens.push(...this._tokenizeArg(arg, def));
        }
        return this._block(B.COMMAND, indent, content, tokens,
          { name: mc, value: arg, def, warnings });
      }
    }

    // Word-starting lines
    if (/^[a-zA-Z_]/.test(content))
      return this._parseWordLine(indent, content);

    return this._block(B.RAW, indent, content, this._tokenizeExpr(content));
  }

  _parseWordLine(indent, content) {
    const m    = content.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)(.*)$/s);
    const word = m[1];
    const rest = m[2] || '';
    const lc   = word.toLowerCase();

    // func definition
    if (lc === 'func') {
      const sig = rest.trimStart();
      return this._block(B.FUNC_DEF, indent, content,
        [[T.KEYWORD, 'func'], [T.SPACE, ' '], ...this._tokenizeFuncSig(sig)],
        { name: 'func', value: sig });
    }

    // for loop
    if (lc === 'for') {
      const expr = rest.trimStart();
      return this._block(B.FOR_LOOP, indent, content,
        [[T.KEYWORD, 'for'], [T.SPACE, ' '], ...this._tokenizeExpr(expr)],
        { name: 'for', value: expr });
    }

    // other keywords
    if (this.keywords.includes(lc)) {
      const arg    = rest.trimStart();
      const def    = this.byId[lc] || null;
      const tokens = [[T.KEYWORD, word]];
      if (arg !== '') { tokens.push([T.SPACE, ' ']); tokens.push(...this._tokenizeExpr(arg)); }
      return this._block(B.KEYWORD, indent, content, tokens,
        { name: word, value: arg, def });
    }

    // single-word command
    if (this.commands.includes(lc)) {
      const arg      = rest.trimStart();
      const def      = this._lookupCommand(word);
      const warnings = this._checkFollow(def, arg);
      const tokens   = [[T.COMMAND, word]];
      if (arg !== '') {
        tokens.push([T.SPACE, ' ']);
        // arg is ONE string span for search-string commands
        tokens.push(...this._tokenizeArg(arg, def));
      }
      return this._block(B.COMMAND, indent, content, tokens,
        { name: word, value: arg, def, warnings });
    }

    // function call: word( or word.Method(
    if (rest.trimStart().startsWith('('))
      return this._parseFuncCall(indent, content, word, rest.trimStart());

    // assignment: x = expr  x++ x--  x += expr
    if (/^\s*[+\-*\/]?=/.test(rest) || rest.trimStart().startsWith('++') || rest.trimStart().startsWith('--')) {
      const tokens = [...this._resolveIdentToken(word), ...this._tokenizeExpr(rest)];
      return this._block(B.ASSIGN, indent, content, tokens,
        { name: word, value: rest.trim() });
    }

    // fallback
    const tokens = [...this._resolveIdentToken(word), ...this._tokenizeExpr(rest)];
    return this._block(B.RAW, indent, content, tokens, { name: word });
  }

  _parseFuncCall(indent, content, name, rest) {
    const def      = this._lookupFuncOrVar(name);
    const tokens   = [...this._resolveIdentToken(name), ...this._tokenizeCallArgs(rest, def)];
    const warnings = (def && def.args && !def.overloads) ? this._checkArgCount(def, rest) : [];
    return this._block(B.CALL, indent, content, tokens,
      { name, value: rest, def, warnings });
  }

  // =========================================================
  // PASS 1C — TREE BUILDER
  // =========================================================

  _buildTree(flat) {
    const blocks = flat.map(b => ({ ...b, children: [], warnings: [...b.warnings] }));
    const n      = blocks.length;
    // Stack frames: { blockIdx: number|null, childIndent: number|null, parentIndent: number }
    const stack  = [{ blockIdx: null, childIndent: null, parentIndent: -1 }];

    for (let bi = 0; bi < n; bi++) {
      const type    = blocks[bi].type;
      const indent  = blocks[bi].indent;
      const trivial = TRIVIAL_TYPES.includes(type);

      if (!trivial) {
        // Pop frames closed by this indent
        while (stack.length > 1) {
          const top = stack[stack.length - 1];
          // Stay: first child and we are deeper than parent
          if (top.childIndent === null && indent > top.parentIndent) break;
          // Stay: matches established sibling indent (correct case)
          if (top.childIndent !== null && indent === top.childIndent) break;
          // Stay: indent > childIndent — this is an inconsistency but still a child, not a pop
          if (top.childIndent !== null && indent > top.childIndent) break;
          // Pop: warn if frame never got children
          if (top.childIndent === null && top.blockIdx !== null)
            blocks[top.blockIdx].warnings.push(
              this._warn(W.EMPTY_BLOCK, 'El bloque esta vacio (no hay lineas con mayor indentacion)')
            );
          stack.pop();
        }

        const top = stack[stack.length - 1];
        const si  = stack.length - 1;

        if (si === 0 && indent > 0) {
          blocks[bi].warnings.push(this._warn(W.ORPHAN,
            'Espaciado inconsistente: no hay condicion ni funcion padre'));
        } else if (top.childIndent === null) {
          stack[si].childIndent = indent;
        } else if (indent !== top.childIndent) {
          blocks[bi].warnings.push(this._warn(W.INCONSISTENT,
            `El espaciado no coincide con la linea anterior (esperado ${top.childIndent}, encontrado ${indent})`));
        }
      }

      // Attach to parent
      const top = stack[stack.length - 1];
      if (top.blockIdx !== null)
        blocks[top.blockIdx].children.push(bi);

      // Push scope
      if (!trivial && SCOPE_OPENERS.includes(type))
        stack.push({ blockIdx: bi, childIndent: null, parentIndent: indent });
    }

    // Flush remaining open frames
    for (let i = stack.length - 1; i >= 1; i--) {
      const f = stack[i];
      if (f.childIndent === null && f.blockIdx !== null)
        blocks[f.blockIdx].warnings.push(
          this._warn(W.EMPTY_BLOCK, 'El bloque esta vacio (no hay lineas con mayor indentacion)')
        );
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

  // =========================================================
  // TOKENIZERS
  // =========================================================

  _tokenizeExpr(expr) {
    const tokens = [];
    let pos = 0;

    while (pos < expr.length) {
      const rest = expr.slice(pos);
      const c    = rest[0];

      // Line comment
      if (rest.startsWith('//')) { tokens.push([T.COMMENT, rest]); break; }

      // Block comment
      if (rest.startsWith('/*')) {
        const close = this._findCommentClose(rest);
        const val   = close !== -1 ? rest.slice(0, close + 2) : rest;
        tokens.push([T.COMMENT, val]);
        pos += val.length;
        continue;
      }

      // Whitespace
      if (c === ' ' || c === '\t') {
        let ws = '';
        while (pos < expr.length && (expr[pos] === ' ' || expr[pos] === '\t')) ws += expr[pos++];
        tokens.push([T.SPACE, ws]);
        continue;
      }

      // @var@ interpolation
      if (c === '@') {
        const end = expr.indexOf('@', pos + 1);
        if (end !== -1) { tokens.push([T.IDENTIFIER, expr.slice(pos, end + 1)]); pos = end + 1; }
        else            { tokens.push([T.IDENTIFIER, rest]); pos = expr.length; }
        continue;
      }

      // Quoted string
      if (c === '"') {
        const end = expr.indexOf('"', pos + 1);
        if (end !== -1) { tokens.push([T.STRING, expr.slice(pos, end + 1)]); pos = end + 1; }
        else            { tokens.push([T.STRING, rest]); pos = expr.length; }
        continue;
      }

      // Operators (longest first, skip :? — only valid at line start)
      let matched = false;
      for (const op of this.operators) {
        if (op === ':?') continue;
        if (rest.startsWith(op)) {
          tokens.push([T.OPERATOR, op]);
          pos += op.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // Parens / brackets
      if ('()'.includes(c)) { tokens.push([T.PAREN, c]);   pos++; continue; }
      if ('[]'.includes(c)) { tokens.push([T.BRACKET, c]); pos++; continue; }

      // Number
      if (/\d/.test(c) || (c === '-' && pos + 1 < expr.length && /\d/.test(expr[pos + 1]))) {
        const nm = rest.match(/^-?\d+(\.\d+)?/);
        tokens.push([T.NUMBER, nm[0]]);
        pos += nm[0].length;
        continue;
      }

      // Word
      if (/[a-zA-Z_]/.test(c)) {
        const wm   = rest.match(/^[a-zA-Z_][a-zA-Z0-9_.]*/);
        const word = wm[0];
        pos += word.length;
        // Inline function call
        if (pos < expr.length && expr[pos] === '(') {
          const def     = this._lookupFuncOrVar(word);
          const tokType = (def && def.type === 'func') ? T.FUNCTION : T.IDENTIFIER;
          tokens.push([tokType, word]);
          let depth = 1; let inner = '('; pos++;
          while (pos < expr.length && depth > 0) {
            const ch = expr[pos];
            inner += ch;
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            pos++;
          }
          tokens.push(...this._tokenizeCallArgs(inner, def));
          continue;
        }
        tokens.push(...this._resolveIdentToken(word));
        continue;
      }

      // Fallback
      tokens.push([T.STRING, c]);
      pos++;
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
      inner += ch;
      i++;
    }
    if (inner !== '') tokens.push(...this._tokenizeExpr(inner));
    tokens.push([T.PAREN, ')']);
    const after = s.slice(i);
    if (after.trim() !== '') tokens.push(...this._tokenizeExpr(after));
    return tokens;
  }

  // For commands: argument is ONE string token (search_string, print_args, etc.)
  // except when follows=expr or follows=number where we tokenize it fully.
  _tokenizeArg(arg, def) {
    const follows = def && def.follows ? def.follows : '';
    switch (follows) {
      case 'number':
      case 'expr':
        return this._tokenizeExpr(arg);
      // search_string: the entire arg is one string token (e.g. "ice sword D", "vigor crossbow *8")
      case 'search_string':
        return [[T.STRING, arg]];
      case 'func_signature':
        return this._tokenizeFuncSig(arg);
      case 'ability_id':
      case 'sound_id':
        return [[T.IDENTIFIER, arg]];
      default:
        return [[T.STRING, arg]];
    }
  }

  _tokenizeSearchStr(str) {
    const tokens     = [];
    const filterVals = this.enumValues['search_filter'] || [];
    const parts      = str.split(/(\s+)/);
    for (const part of parts) {
      if (part === '') continue;
      if (/^\s+$/.test(part))           { tokens.push([T.SPACE, part]); }
      else if (filterVals.includes(part.toLowerCase())) { tokens.push([T.VARIABLE, part]); }
      else if (/^[*+\-]\d/.test(part))  { tokens.push([T.NUMBER, part]); }
      else if (/^@[^@]+@$/.test(part))  { tokens.push([T.IDENTIFIER, part]); }
      else                              { tokens.push([T.STRING, part]); }
    }
    return tokens;
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
        if (p)  tokens.push([T.IDENTIFIER, p]);
      });
      tokens.push([T.PAREN, ')']);
    }
    return tokens;
  }

  // =========================================================
  // LOOKUP HELPERS
  // =========================================================

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

  // =========================================================
  // VALIDATION
  // =========================================================

  _checkFollow(def, arg) {
    if (!def || !def.follows) return [];
    if (arg.trim() !== '') return [];
    // If follows is set, there is at least one required argument unless all are optional
    const args     = def.args || [];
    const required = args.length === 0
      ? 1  // no args array but follows is declared → implicitly required
      : args.filter(a => !a.optional).length;
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

  // =========================================================
  // PASS 2 — HTML RENDERER
  // =========================================================

  _blockToHtml(block, depth = 0) {
    if (block.type === B.EMPTY) return '';

    const indent = ' '.repeat(block.indent);

    // Warnings that go BEFORE the line (indent/orphan issues)
    const preWarns = block.warnings
      .filter(w => w.type !== W.EMPTY_EXPR && w.type !== W.EMPTY_BLOCK)
      .map(w => this._warnSpan('⚠', w.message))
      .join('');

    // Warnings that go AFTER the line content (empty expr, empty block)
    const postWarns = block.warnings
      .filter(w => w.type === W.EMPTY_EXPR || w.type === W.EMPTY_BLOCK)
      .map(w => this._warnSpan('?', w.message))
      .join('');

    let html = indent + preWarns + this._renderTokens(block.tokens) + postWarns;

    for (const child of block.children) {
      const ch = this._blockToHtml(child, depth + 1);
      if (ch !== '') html += '\n' + ch;
    }
    return html;
  }

  _renderTokens(tokens) {
    return tokens.map(([type, value]) => {
      if (type === T.SPACE) return this._esc(value || ' ');
      return `<span class="${type}">${this._esc(value)}</span>`;
    }).join('');
  }

  _warnSpan(text, msg) {
    return `<span class="warning" data-warning="${this._esc(msg)}">${this._esc(text)}</span>`;
  }

  _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // =========================================================
  // UTILITIES
  // =========================================================

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

// Export for Node.js; also available as global in browser
if (typeof module !== 'undefined') module.exports = { StonescriptParser, B, T, W };
