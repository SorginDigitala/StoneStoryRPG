# Prompt: Revisión del editor Stonescript

Adjunto tres archivos: `stonescript-api.json`, `StonescriptParser.js`, `index.html`.
Se trata de un editor de código para el lenguaje **Stonescript** del videojuego Stone Story RPG.
El proyecto es **serverless** (GitHub Pages). No hay backend.
Tu tarea es revisar el código en busca de incoherencias entre lo que el JSON declara y lo que el parser y el editor implementan.

---

# 1. EL JSON (`stonescript-api.json`)

Es la **única fuente de verdad**. El parser y el editor deben leer todo del JSON, sin hardcodear reglas.
Tiene 374 entradas. Cada entrada tiene como mínimo `{id, type}`.

## Tipos de entrada (`type`)

| type | descripción |
|------|-------------|
| `control_flow` | Estructuras de control: `?`, `:`, `:?` |
| `comment` | `//` y `/* */` |
| `line_continuation` | `^` |
| `operator` | Operadores matemáticos y de comparación |
| `keyword` | Palabras clave del lenguaje |
| `command` | Comandos ejecutables |
| `var` | Variable nativa del juego |
| `func` | Función nativa del juego |
| `syntax` | Sintaxis especial (`array[index]`) |
| `enum` | Enumeración de valores válidos |
| `meta` | Metadatos del parser (`__validation__`) |

## Campos posibles por entrada

| campo | descripción |
|-------|-------------|
| `id` | Identificador único (requerido) |
| `type` | Tipo de entrada (requerido) |
| `syntax` | Sintaxis de uso |
| `opens_block` | Si abre un bloque indentado |
| `follows` | Tipo de argumento que espera después |
| `examples` | Ejemplos de uso |
| `validate` | Objeto con reglas de validación específicas |
| `args` | Array de argumentos `{name, type, optional, default?}` |
| `overloads` | Array de variantes de firma |
| `group` | Grupo al que pertenece la variable/función |
| `return_type` | Tipo que devuelve |
| `sealed_group` | Si pertenece a un grupo sellado |
| `context` | Para operadores: `comparison` o `math` |
| `arg_validation` | Para `activate`: reglas de ability IDs |
| `values` | Para enums: lista de valores válidos |

---

## CONTROL FLOW

### `?` — Condición
```
syntax:      ?<expr>
opens_block: true
follows:     expr
validate:
  expression_required:     true
  no_keywords_as_operands: true   (no se puede usar var, func, for... como operando)
  no_embedded_condition:   true   (no puede haber ? dentro de la expresión)
  no_bare_string:          true   (no string sin operador)
  no_trailing_junk:        true   (nada tras el último valor sin operador)
valid_operators: = ! & | > < >= <= ! (negation)
```

### `:` — Else
```
syntax:      :
opens_block: true
Válido solo como: ':' solo, '://', ':/*', ': //', ': /*'
Cualquier otro carácter tras ':' es error.
```

### `:?` — Elseif
```
syntax:      :?<expr>
opens_block: true
follows:     expr
Mismas reglas de validación que '?'
```

---

## COMMENTS

### `//` — Comentario de línea
```
syntax:  // <text>
follows: text
Los comentarios ignoran la indentación. Pueden aparecer en cualquier nivel.
```

### `/* */` — Comentario de bloque
```
syntax:    /* <text> */
multiline: true
Un bloque /* */ solo se colapsa como multilínea si /* está al inicio de línea sin código antes.
Si hay código antes del /*, es un comentario inline y lo maneja el tokenizador.
```

---

## LINE CONTINUATION

### `^`
```
syntax:  ^<expr>
follows: expr
El primer carácter no-espacio tras ^ debe estar en continuation_must_start_with:
  ['&', '|', '(', '.', '[', ']', ',']
```

---

## OPERATORS

| id | context | descripción |
|----|---------|-------------|
| `=` | comparison | Igualdad |
| `!` | comparison | Desigualdad |
| `&` | comparison | AND lógico |
| `\|` | comparison | OR lógico |
| `>` | comparison | Mayor que |
| `<` | comparison | Menor que |
| `>=` | comparison | Mayor o igual |
| `<=` | comparison | Menor o igual |
| `! (negation)` | negation | Negación booleana (`!ai.enabled`) |
| `+` | math | Suma |
| `-` | math | Resta |
| `*` | math | Multiplicación |
| `/` | math | División |
| `++` | math | Incremento |
| `--` | math | Decremento |
| `%` | math | Módulo |
| `( )` | math | Agrupación |

---

## KEYWORDS

### `var`
```
syntax:  var <n> [= <expr>]
follows: identifier
validate:
  identifier_pattern: ^[a-zA-Z_][a-zA-Z0-9_]*$
  single_declaration: true   (solo una variable por línea 'var')
  no_junk_after_value: true  (nada inesperado tras el valor)
  reserved_names: [Type, ai, ambient, anim, armor, array, b, bighead, buffs,
    button, canvas, color, component, debuffs, draw, encounter, event, face,
    foe, harvest, hp, input, int, item, key, loc, math, maxarmor, maxhp,
    music, panel, pickup, player, pos, res, rng, rngf, screen, storage,
    string, summon, sys, te, text, time, totalgp, totaltime, ui, utc]

Caso especial: 'var x = import Path/File' es válido.
  El path se valida con import.validate.pattern.
  'x' se añade a importRoots: sus propiedades/métodos NO se validan (opaco).
```

### `func`
```
syntax:      func <n>([params])
follows:     func_signature
opens_block: true
validate:
  name_pattern:      ^[a-zA-Z_][a-zA-Z0-9_]*$
  name_pattern_desc: Solo letras, dígitos y _. No empieza por número.
  no_trailing_junk:  true   (nada tras la firma en la misma línea)
```

### `for` (rango)
```
syntax:      for <v> = <a>..<b>
follows:     for_expr
opens_block: true
La variable <v> se añade a declared en scope analysis.
```

### `for :` (iteración)
```
syntax:      for <v> : <array>
follows:     for_expr
opens_block: true
La variable <v> se añade a declared en scope analysis.
El regex para detectar la variable es: /^([a-zA-Z_][a-zA-Z0-9_]*)\s*[=:]/
```

### `return`
```
syntax:  return [<expr>]
follows: expr
Fuera de funciones actúa como exit(). Es válido en cualquier nivel de indentación dentro de su bloque padre.
```

### `break`
```
syntax: break
Válido dentro de bucles for.
```

### `continue`
```
syntax: continue
Válido dentro de bucles for.
```

### `import`
```
syntax:  import <script_path>
follows: script_path
validate:
  no_spaces:   true
  non_empty:   true
  pattern:     ^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$
  pattern_desc: Segmentos separados por /. Solo letras, dígitos, _ . -
```

### `new`
```
syntax:  new <script_path>
follows: script_path
(mismas reglas de ruta que import)
```

### `ascii`
```
syntax:  ascii\n<art>\nasciiend
validate:
  requires_asciiend: true
  valid_after_ids:   [>f, >h, >`, >c, >o, >(]
  También válido como valor de var: 'var x = ascii...'
  'asciiend' suelto sin ascii previo → error
```

---

## COMMANDS

Todos los comandos tienen `follows` que indica el tipo de argumento.
Los `follows` en `literal_arg_follows` indican que el argumento NO es una expresión de variables: el scope analysis no debe revisar esos tokens.

| id | follows | args |
|----|---------|------|
| `equip` | search_string | — |
| `equipL` | search_string | — |
| `equipR` | search_string | — |
| `loadout` | number | — |
| `activate` | ability_id | ver arg_validation abajo |
| `brew` | ingredient_expr | — |
| `play` | sound_id | `sound:sound_id`, `pitch:number?` |
| `>` | string | — |
| `>o` | print_args | — |
| `>\`` | print_args | — |
| `>c` | print_args | — |
| `>f` | print_args | — |
| `>h` | print_args | — |
| `>(` | string | — |
| `disable hud` | hud_opts | `opts:string?` |
| `enable hud` | hud_opts | `opts:string?` |
| `disable/enable abilities` | — | — |
| `disable/enable banner` | — | — |
| `disable/enable loadout input` | — | — |
| `disable/enable loadout print` | — | — |
| `disable/enable npcDialog` | — | — |
| `disable/enable pause` | — | — |
| `disable/enable player` | — | — |

### `activate` — arg_validation
```
fixed_values:       [l, left, p, potion, r, right]
known_ability_ids:  [bardiche, bash, blade, cinderwisp, compound, dash, hatchet,
  heavy_hammer, lollipop_wand, mask, mind, quarterstaff, shovel, skeleton_arm,
  staff_aether, staff_fire, staff_ice, staff_poison, staff_stone, staff_vigor,
  talisman_aether, talisman_fire, voidweaver, wand_aether, wand_fire, wand_ice,
  wand_poison, wand_stone, wand_vigor]
case_insensitive: true
charset:          ^[a-zA-Z_][a-zA-Z0-9_]*$
```

---

## ENUMS

### `search_filter`
```
poison, vigor, aether, fire, air, ice, arachnid, serpent, insect, machine,
humanoid, elemental, boss, phase1, phase2, phase3, spawner, flying, slow,
ranged, explode, swarm, unpushable, undamageable, magic_resist,
magic_vulnerability, immune_to_stun, immune_to_ranged,
immune_to_debuff_damage, immune_to_physical
```

### `key_code`
```
left, leftBegin, right, rightBegin, up, upBegin, down, downBegin,
primary, primaryBegin, back, backBegin, ability1, ability1Begin,
ability2, ability2Begin, bumpL, bumpLBegin, bumpR, bumpRBegin, begin
```

---

## VARIABLES Y FUNCIONES NATIVAS

### Grupos sellados (`sealed_groups`)
Propiedad inexistente en estos grupos → error `sealed_property`:
```
ambient, color, draw, encounter, event, foe, harvest, input, int, item,
key, loc, math, music, pickup, player, res, rng, screen, storage, string,
summon, sys, te, time
```

### Raíces no asignables (`non_assignable_roots`)
```
ai, ambient, armor, bighead, buffs, debuffs, encounter, face, foe, harvest,
hp, input, item, key, loc, math, maxarmor, maxhp, music, pickup, player,
pos, res, rng, rngf, screen, summon, sys, te, time, totalgp, totaltime, utc
```

### Grupo `loc`
| id | type | return_type |
|----|------|-------------|
| `loc` | var | string |
| `loc.id` | var | string |
| `loc.gp` | var | number |
| `loc.name` | var | string |
| `loc.stars` | var | number |
| `loc.begin` | var | bool |
| `loc.loop` | var | bool |
| `loc.isQuest` | var | bool |
| `loc.averageTime` | var | number |
| `loc.bestTime` | var | number |
| `loc.Leave()` | func | void | — |
| `loc.Pause()` | func | void | — |

### Grupo `encounter`
| `encounter.isElite` | var | bool | | `encounter.eliteMod` | var | string |

### Grupo `foe`
| id | type | return_type | args |
|----|------|-------------|------|
| `foe` | var | string | |
| `foe.id` | var | string | |
| `foe.name` | var | string | |
| `foe.damage` | var | number | |
| `foe.distance` | var | number | |
| `foe.z` | var | number | |
| `foe.count` | var | number | |
| `foe.GetCount` | func | number | `radius:int` |
| `foe.hp` | var | number | |
| `foe.maxhp` | var | number | |
| `foe.armor` | var | number | |
| `foe.maxarmor` | var | number | |
| `foe.state` | var | number | |
| `foe.time` | var | number | |
| `foe.level` | var | number | |

### Grupos `foe.buffs` y `foe.debuffs`
| id | type | return_type | args |
|----|------|-------------|------|
| `foe.buffs.count` | var | number | |
| `foe.buffs.string` | var | string | |
| `foe.buffs.GetCount` | func | number | `buffId:string` |
| `foe.buffs.GetTime` | func | number | `buffId:string` |
| `foe.debuffs.count` | var | number | |
| `foe.debuffs.string` | var | string | |
| `foe.debuffs.GetCount` | func | number | `debuffId:string` |
| `foe.debuffs.GetTime` | func | number | `debuffId:string` |

### Grupos `player.buffs` y `player.debuffs`
| id | type | return_type | args |
|----|------|-------------|------|
| `buffs.count` | var | number | |
| `buffs.string` | var | string | |
| `buffs.GetCount` | func | number | `buffId:string` |
| `buffs.GetTime` | func | number | `buffId:string` |
| `buffs.oldest` | var | string | |
| `debuffs.count` | var | number | |
| `debuffs.string` | var | string | |
| `debuffs.GetCount` | func | number | `debuffId:string` |
| `debuffs.GetTime` | func | number | `debuffId:string` |
| `debuffs.oldest` | var | string | |

### Grupo `harvest`
| `harvest` | var | string | | `harvest.distance` | var | number | | `harvest.z` | var | number |

### Grupo `input`
| `input.x` | var | number | | `input.y` | var | number |

### Grupo `item`
| id | type | return_type | args |
|----|------|-------------|------|
| `item.left` | var | string | |
| `item.right` | var | string | |
| `item.left.gp` | var | number | |
| `item.right.gp` | var | number | |
| `item.left.id` | var | string | |
| `item.right.id` | var | string | |
| `item.left.state` | var | number | |
| `item.left.time` | var | number | |
| `item.right.state` | var | number | |
| `item.right.time` | var | number | |
| `item.potion` | var | string | |
| `item.CanActivate` | func | bool | overloaded: `()` o `(itemId:string)` |
| `item.GetCooldown` | func | int | `abilityId:string` |
| `item.GetCount` | func | int | `searchString:string` |
| `item.GetLoadoutL` | func | string | `loadoutN:int` |
| `item.GetLoadoutR` | func | string | `loadoutN:int` |
| `item.GetTreasureCount` | func | int | — |
| `item.GetTreasureLimit` | func | int | — |

### Grupo `pickup`
| `pickup` | var | string | | `pickup.distance` | var | number | | `pickup.z` | var | number |

### Grupo `player`
| id | type | return_type | args |
|----|------|-------------|------|
| `armor` | var | number | |
| `armor.f` | var | number | |
| `hp` | var | number | |
| `maxhp` | var | number | |
| `maxarmor` | var | number | |
| `pos.x`, `pos.y`, `pos.z` | var | number | |
| `ai.enabled`, `ai.paused`, `ai.idle`, `ai.walking` | var | bool | |
| `bighead` | var | bool | |
| `face` | var | string | |
| `key` | var | string | |
| `totalgp` | var | number | |
| `player.direction` | var | number | |
| `player.framesPerMove` | var | number | |
| `player.moveX`, `player.moveZ` | var | number | |
| `player.moveAddX`, `player.moveAddZ` | var | number | |
| `player.name` | var | string | |
| `player.GetNextLegendName` | func | string | — |
| `player.ShowScaredFace` | func | void | `duration:number` |

### Grupo `res`
`res.stone`, `res.wood`, `res.tar`, `res.ki`, `res.bronze`, `res.crystals` — todos `var → number`

### Grupo `rng`
| `rng` | var | number | | `rngf` | var | float |

### Grupo `screen`
| id | type | return_type | args |
|----|------|-------------|------|
| `screen.i`, `screen.x`, `screen.w`, `screen.h` | var | number | |
| `screen.FromWorldX` | func | int | `worldX:int` |
| `screen.FromWorldZ` | func | int | `worldZ:int` |
| `screen.ToWorldX` | func | int | `screenX:int` |
| `screen.ToWorldZ` | func | int | `screenY:int` |
| `screen.Next` | func | void | — |
| `screen.Previous` | func | void | — |
| `screen.ResetOffset` | func | void | — |

### Grupo `summon`
| id | type | return_type | args |
|----|------|-------------|------|
| `summon.count` | var | number | |
| `summon.GetId` | func | string | `index:int?=0` |
| `summon.GetName` | func | string | `index:int?=0` |
| `summon.GetVar` | func | any | `varName:string, index:int?=0` |
| `summon.GetState` | func | number | `index:int?=0` |
| `summon.GetTime` | func | number | `index:int?=0` |

### Grupo `time`
| id | type | return_type | args |
|----|------|-------------|------|
| `time` | var | number | |
| `totaltime` | var | number | |
| `time.msbn` | var | BigNumber | |
| `time.year/month/day/hour/minute/second` | var | number | |
| `utc.year/month/day/hour/minute/second` | var | number | |
| `time.FormatCasual` | func | string | `frames:int, precise:bool?` |
| `time.FormatDigital` | func | string | `frames:int, precise:bool?` |

### Grupo `ambient`
| `ambient` | var | string | | `ambient.Add` | func | void | `soundId:string` | | `ambient.Stop` | func | void | — |

### Grupo `math`
| id | type | return_type | args |
|----|------|-------------|------|
| `math.Abs` | func | number | `num:number` |
| `math.Acos`, `math.Asin`, `math.Atan` | func | number | `num:number` |
| `math.Atan2` | func | number | `y:number, x:number` |
| `math.Ceil` | func | number | `num:number` |
| `math.CeilToInt` | func | int | `num:number` |
| `math.Clamp` | func | number | `num:number, min:number, max:number` |
| `math.Cos`, `math.Sin`, `math.Tan` | func | number | `num:number` |
| `math.e` | var | float | |
| `math.Exp` | func | number | `num:number` |
| `math.Floor` | func | number | `num:number` |
| `math.FloorToInt` | func | int | `num:number` |
| `math.Lerp` | func | number | `a:number, b:number, t:number` |
| `math.Log` | func | number | `num:number, base:number` |
| `math.Max`, `math.Min` | func | number | `num1:number, num2:number` |
| `math.pi` | var | float | |
| `math.Pow` | func | number | `num:number, p:number` |
| `math.Round` | func | number | `num:number` |
| `math.RoundToInt` | func | int | `num:number` |
| `math.Sign` | func | number | `num:number` |
| `math.Sqrt` | func | number | `num:number` |
| `math.ToDeg` | func | number | `radians:number` |
| `math.ToRad` | func | number | `degrees:number` |

### Grupo `BigNumber`
| id | type | return_type | args |
|----|------|-------------|------|
| `math.BigNumber` | func | BigNumber | `value:number\|string` |
| `b.Add`, `b.Sub`, `b.Mul`, `b.Div` | func | BigNumber | `value:number\|BigNumber` |
| `b.Eq`, `b.Gt`, `b.Ge`, `b.Lt`, `b.Le` | func | bool | `value:number\|BigNumber` |
| `b.ToFloat` | func | float | — |
| `b.ToInt` | func | int | — |
| `b.ToString` | func | string | — |
| `b.ToUI` | func | string | — |

### Grupo `color`
| `color.FromRGB` | func | string | `r:int, g:int, b:int` |
| `color.ToRGB` | func | int[3] | `color:string` |
| `color.Lerp` | func | string | `c1:string, c2:string, t:float` |
| `color.Random` | func | string | — |

### Grupo `draw`
| id | type | return_type | args |
|----|------|-------------|------|
| `draw.Bg` | func | void | overloaded: `(x,y,color)` o `(x,y,color,w,h)` |
| `draw.Box` | func | void | `x:int, y:int, w:int, h:int, color:string, style:int` |
| `draw.Clear` | func | void | — |
| `draw.GetSymbol` | func | string | `x:int, y:int` |
| `draw.Player` | func | void | `x:int?, y:int?` |

### Grupo `event`
| `event.GetObjectiveId` | func | string | `index:int` |
| `event.GetObjectiveProgress` | func | int | `index:int` |
| `event.GetObjectiveGoal` | func | int | `index:int` |

### Grupo `int`
| `int.Parse` | func | int | `str:string` |

### Grupo `key`
| id | type | return_type | args |
|----|------|-------------|------|
| `key.Bind` | func | void | `action:string, key1:string, key2:string?` |
| `key.GetKeyAct` | func | string | `key:string` |
| `key.GetActKey` | func | string | `action:string` |
| `key.GetActKey2` | func | string | `action:string` |
| `key.GetActLabel` | func | string | `action:string` |
| `key.ResetBinds` | func | void | — |

### Grupo `music`
| `music` | var | string | | `music.Play` | func | void | `trackId:string` | | `music.Stop` | func | void | — |

### Grupo `storage`
| id | type | return_type | args |
|----|------|-------------|------|
| `storage.Delete` | func | void | `key:string` |
| `storage.Get` | func | any | overloaded: `(key:string)` o `(key:string, default:any)` |
| `storage.Has` | func | bool | `key:string` |
| `storage.Incr` | func | int | overloaded: `(key:string)` o `(key:string, amount:int)` |
| `storage.Keys` | func | array | — |
| `storage.Set` | func | void | `key:string, value:any` |

### Grupo `string`
| id | type | return_type | args |
|----|------|-------------|------|
| `string.Break` | func | array | `str:string, maxWidth:int` |
| `string.Capitalize` | func | string | `str:string` |
| `string.Equals` | func | bool | `str1:string, str2:string` |
| `string.Format` | func | string | `template:string, ...values:any` |
| `string.IndexOf` | func | int | overloaded: `(str,criteria)` o `(str,criteria,startAt:int)` |
| `string.Join` | func | string | `separator:string, array:array, startAt:int?, count:int?` |
| `string.Size` | func | int | `str:string` |
| `string.Split` | func | array | `str:string, separators:string?, keepEmpty:bool?` |
| `string.Sub` | func | string | overloaded: `(str,startAt:int)` o `(str,startAt,length:int)` |
| `string.ToLower`, `string.ToUpper` | func | string | `str:string` |

### Grupo `sys`
| id | type | return_type | args |
|----|------|-------------|------|
| `sys.cacheRemoteFiles` | var | bool | |
| `sys.fileUrl` | var | string | |
| `sys.isMobile`, `sys.isPC` | var | bool | |
| `sys.os` | var | string | |
| `sys.SetFileUrl` | func | void | `url:string` |
| `sys.MindConnect` | func | void | — |

### Grupo `te`
| `te.language` | var | string | | `te.xt` | func | string | `text:string` |
| `te.GetTID` | func | string | `text:string` | | `te.ToEnglish` | func | string | `text:string` |

### Grupo `misc`
| `Type` | func | string | `var:any` |

### Grupos UI
`Component`, `Panel`, `Text`, `Button`, `Anim`, `Canvas` — no se validan por scope analysis (son objetos dinámicos).

### Grupo `array`
| id | type | return_type | args |
|----|------|-------------|------|
| `array.Count` | func | int | — |
| `array.Clear` | func | void | — |
| `array.Contains` | func | bool | `value:any` |
| `array[index]` | syntax | — | — |

Los métodos de array solo son válidos sobre variables de tipo array o sobre literales `[...].Method()`.
Sobre un literal, solo se permiten los métodos del grupo `array`. Un método desconocido en `[...].X()` es un `undeclared_variable`.

---

## ENTRY `__validation__` (type: `meta`)

Contiene todos los conjuntos de reglas globales. El parser los lee desde aquí:

```
sealed_groups: [ambient, color, draw, encounter, event, foe, harvest, input,
  int, item, key, loc, math, music, pickup, player, res, rng, screen, storage,
  string, summon, sys, te, time]

reserved_var_names: [Type, ai, ambient, anim, armor, array, b, bighead, buffs,
  button, canvas, color, component, debuffs, draw, encounter, event, face, foe,
  harvest, hp, input, int, item, key, loc, math, maxarmor, maxhp, music, panel,
  pickup, player, pos, res, rng, rngf, screen, storage, string, summon, sys, te,
  text, time, totalgp, totaltime, ui, utc]

comparison_operators:        [=, !, <, >, <=, >=]
logical_operators:           [&, |]
continuation_must_start_with:[&, |, (, ., [, ], ,]

keywords_not_allowed_in_expr:[ascii, break, continue, for, for :, func,
                               import, new, return, var]

literal_arg_follows: [search_string, ability_id, sound_id, hud_opts,
                       ingredient_expr, script_path, print_args, string]
  → Si el 'follows' de un comando está en esta lista, el argumento es
    un literal: el scope analysis NO debe revisar sus tokens.

non_assignable_roots: [ai, ambient, armor, bighead, buffs, debuffs, encounter,
  face, foe, harvest, hp, input, item, key, loc, math, maxarmor, maxhp, music,
  pickup, player, pos, res, rng, rngf, screen, summon, sys, te, time, totalgp,
  totaltime, utc]

identifier_pattern:   ^[a-zA-Z_][a-zA-Z0-9_]*$
exit_keywords:        [return, break]

known_module_roots:   [ambient, battle, color, draw, event, key, loc, loop,
  math, music, screen, storage, string, summon, sys, te, time, ui, utc]
  → Raíces de módulos válidas aunque no se hayan declarado con 'var'.
    Sus propiedades/métodos no se validan (opacos).

arg_type_check_enabled: true

arg_type_rules:
  string: valid_tokens=[string]
          (una variable siempre pasa; solo se rechaza un literal del tipo incorrecto)
  int:    valid_tokens=[number], integer_only=true
  float:  valid_tokens=[number]
  number: valid_tokens=[number]
  bool:   valid_tokens=[identifier|variable], valid_literals=[true, false]
  any:    valid_tokens=[string, number, variable, identifier, function]
```

---

# 2. EL PARSER (`StonescriptParser.js`)

## Principio fundamental: Data-Driven

**Toda regla de validación debe leerse del JSON.** El parser no hardcodea listas de nombres, patrones ni conjuntos. Cada vez que el parser necesita saber si algo es válido, consulta el JSON a través de sus índices internos.

Las únicas excepciones son las reglas estructurales del árbol (indentación, scope) que son algoritmos, no datos.

## Constructor: `StonescriptParser(api)`

Recibe el array JSON completo. `_buildIndex()` construye los índices internos:

```javascript
// Índices de lookup
this.byId              // Map: id → entry completa
this.commands          // string[] — IDs de comandos de una sola palabra (lowercase)
this.multiCmds         // string[] — IDs multi-palabra, ordenados por longitud desc (para match correcto)
this.keywords          // string[] — IDs de keywords (lowercase)
this.keywordSet        // Set<string> — para lookup O(1)
this.varRoots          // string[] — raíces de vars nativas + known_module_roots
this.enumValues        // Map: id → string[] — valores de enums (search_filter, key_code)
this.printPfx          // string[] — prefijos de print ordenados por longitud desc

// Configuraciones de validación (leídas del JSON, NO hardcodeadas)
this.importValidate       // ← import.validate
this.varValidate          // ← var.validate
this.condValidate         // ← ?.validate
this.funcValidate         // ← func.validate
this.abilityFixed         // Set ← activate.arg_validation.fixed_values
this.abilityKnown         // Set ← activate.arg_validation.known_ability_ids
this.abilityCharset       // RegExp ← activate.arg_validation.charset
this.argTypeRules         // ← __validation__.arg_type_rules
this.argTypeCheckEnabled  // ← __validation__.arg_type_check_enabled

// Sets data-driven (leídos de __validation__)
this.comparisonOps        // Set ← comparison_operators
this.logicalOps           // Set ← logical_operators
this.literalArgFollows    // Set ← literal_arg_follows
this.exitKeywords         // Set ← exit_keywords
```

## Método principal: `parse(code) → Block[]`

```
1. rawLines = _splitLines(code)
   ↓ colapsa /* */ multilínea y ascii...asciiend en bloques únicos

2. flat = rawLines.map(_parseLine)
   ↓ cada línea → Block con type, indent, raw, tokens, warnings, lineNum
   lineNum se asigna acumulando las \n de cada bloque:
     let srcLine = 0
     flat = rawLines.map(l => {
       b = _parseLine(l)
       b.lineNum = srcLine
       srcLine += l.split('\n').length
       return b
     })

3. tree = _buildTree(flat)
   ↓ anida los bloques según indentación

4. _scopeAnalysis(tree)
   ↓ detecta variables no declaradas, modifica tokens de T.IDENTIFIER → T.UNKNOWN

return tree
```

## Tipos de bloque (`B.*`)

```
condition    → ?<expr>
elseif       → :?<expr>
else         → :
comment      → // o /* */
continuation → ^<expr>
command      → equip, activate, brew...
print        → >, >`, >o, >f, >h, >c, >(
keyword      → var, for, return, import, break, continue, new
func_def     → func Name(params)
for_loop     → for v=a..b  |  for v:array
assign       → x = expr, x++, x--
call         → Name(args)
empty        → línea vacía
raw          → línea que no encaja en ningún otro tipo
ascii        → bloque ascii...asciiend
```

## Tipos de token (`T.*`)

| token | color CSS | descripción |
|-------|-----------|-------------|
| `control` | `#e0e0e0 bold` | `?` `:` `:?` |
| `comment` | `#4e6e4e italic` | comentarios |
| `continue-op` | `#666` | `^` |
| `command` | `#9acdaa` | equip, brew... |
| `keyword` | `var(--accent)` (azul) | var, func, for... |
| `print` | `#9acdaa bold` | `>` `>\`` `>o`... |
| `variable` | `#c8c8c8` | variable nativa conocida |
| `function` | `#5ab4d4` | función nativa conocida |
| `operator` | `#777` | `=` `!` `+` `-`... |
| `number` | `#c5b07a` | literales numéricos |
| `string` | `#8a7a6a` | `"texto"` |
| `identifier` | `#aaa` | identificador no nativo |
| `paren` | `#555` | `(` `)` |
| `bracket` | `#555` | `[` `]` |
| `space` | (sin span) | espacios y tabs |
| `unknown` | `#c8a020 underline wavy` | variable **no declarada** |

## Warnings (`W.*`) y severidad

| constante | severity | descripción |
|-----------|----------|-------------|
| `orphan_indent` | **error** | Bloque indentado sin padre |
| `inconsistent_indent` | **error** | Indent no coincide con siblings |
| `empty_block` | **error** | SCOPE_OPENER sin hijos |
| `empty_expression` | **error** | `?` sin expresión |
| `invalid_follow` | **error** | Falta argumento requerido |
| `wrong_arg_count` | **error** | Número de args incorrecto |
| `invalid_operator` | **error** | Operador no válido (`==`, `=!`) |
| `unknown_command` | **error** | Comando no reconocido |
| `invalid_import` | **error** | Ruta de import inválida |
| `invalid_var_name` | **error** | Nombre de variable inválido |
| `invalid_activate` | **error** | Ability ID no reconocido |
| `sealed_property` | **error** | Propiedad inexistente en grupo sellado |
| `invalid_statement` | **error** | Asignación a variable nativa no asignable |
| `invalid_expression` | **error** | Expresión de condición inválida |
| `invalid_continuation` | **error** | `^` con contenido no permitido |
| `invalid_ascii` | **error** | `ascii`/`asciiend` fuera de contexto |
| `invalid_arg_type` | **error** | Literal del tipo incorrecto en un arg |
| `bad_expr` | **error** | Error de expresión genérico |
| `undeclared_variable` | **warning** | Variable no declarada (amarillo, no bloquea) |

## `_splitLines(code)` — Colapsado de bloques multilínea

Antes de parsear, colapsa algunos patrones en un único bloque:

**Comentario de bloque `/* */` multilínea:**
- Solo colapsa si `/*` es el primer contenido de la línea (sin código antes).
- Si `//` precede al `/*` en la misma línea, el `/*` NO abre bloque.
- Si abre y cierra en la misma línea, no colapsa.

**Bloque `ascii...asciiend`:**
- Detectado por regex `/\bascii\s*$/` al final del contenido de la línea (sin contar comentarios inline).
- Colapsa hasta encontrar una línea cuyo `trimStart()` empiece por `asciiend`.

## `_parseLine(rawLine) → Block`

Determina el tipo de bloque y genera los tokens para cada línea:

```
1. Si rawLine contiene '\n':
   - Si _isAsciiBlock(content) → _parseAsciiBlock()
   - Else → B.COMMENT (bloque /* */ colapsado)

2. content = rawLine.trimStart(), indent = _leadingSpaces(rawLine)
   _leadingSpaces(): tab = 2 espacios, space = 1 espacio

3. '' → B.EMPTY

4. '^' → B.CONTINUATION + _tokenizeExpr(rest)
   Valida que rest empiece con algo de continuation_must_start_with

5. '/*' que cierra en misma línea → B.COMMENT
6. '//' → B.COMMENT

7. ':?' → B.ELSEIF + _tokenizeExpr(after) + _checkConditionExpr
8. ':' solo, ':// ', ':/* ' → B.ELSE (con validación restrictiva)
9. '?' → B.CONDITION + _tokenizeExpr(after) + _checkConditionExpr

10. Para cada prefix en printPfx → B.PRINT

11. Para cada cmd en multiCmds (longest first) → B.COMMAND

12. Si starts con [a-zA-Z_] → _parseWordLine()

13. Else → B.RAW + _tokenizeExpr(content) + _flushInlineWarnings()
```

## `_parseWordLine(indent, content)`

```
word = primera palabra, rest = resto

'func'  → B.FUNC_DEF   + _tokenizeFuncSig + _checkFuncSig (lee func.validate)
'for'   → B.FOR_LOOP   + _tokenizeExpr
keyword → B.KEYWORD    + validación específica según keyword_special_handlers
command → B.COMMAND    + _tokenizeArg según follows + _checkFollow + _checkCommand
rest starts '(' → _parseFuncCall() → B.CALL
rest has '=', '++', '--' → B.ASSIGN
else → B.RAW
```

## `_buildTree(flat) → Block[]`

```
SCOPE_OPENERS = [condition, elseif, else, func_def, for_loop]
  → Estos tipos abren un nuevo frame en el stack de indentación.

TRIVIAL_TYPES = [empty, continuation, comment]
  → Transparentes al stack: no lo modifican, no reciben warnings de indentación.
  → Los comentarios pueden tener cualquier indentación.

Frame: { blockIdx, childIndent, parentIndent }
  → childIndent: null hasta el primer hijo, luego fijo para todos los siblings.
  → Reglas:
    - indent > parentIndent, childIndent=null → OK, fija childIndent
    - indent === childIndent → OK, sibling normal
    - indent > childIndent → OK (hijos más profundos permitidos)
    - indent < childIndent → pop del frame
    - indent ≠ childIndent (tras fijar) → W.INCONSISTENT
    - indent > 0 en root → W.ORPHAN
    - SCOPE_OPENER cerrado sin hijos → W.EMPTY_BLOCK
```

## `_scopeAnalysis(blocks)`

### Pass A: Collect (una pasada global, sin respetar scopes de función)

```javascript
// Para cada bloque en el árbol:
if (type === 'keyword' && name === 'var' && value) {
  match = value.match(/^([a-zA-Z_]\w*)/)
  if (value starts 'import ') → importRoots.add(name)
  else                        → declared.add(name)
}
if (type === 'func_def' && value) {
  nameMatch = value.match(/^([a-zA-Z_]\w*)/) → declared.add(name)
  paramsMatch = value.match(/\(([^)]*)\)/)   → declared.add(each param)
}
if (type === 'for_loop' && value) {
  match = value.match(/^([a-zA-Z_]\w*)\s*[=:]/) → declared.add(varName)
  // El regex [=:] captura tanto 'for v=a..b' como 'for v:array'
}
```

### Pass B: Check

Para cada bloque, itera sus tokens de tipo `T.IDENTIFIER`:

**Skip (no se comprueba) si:**

| condición | motivo |
|-----------|--------|
| En posición RHS de operador de comparación | `?loc=haunted halls` — todos los tokens hasta el siguiente `&`/`|` o `(` son el valor |
| Bloque es `B.COMMAND` con `follows` en `literalArgFollows` | El arg es un literal, no una variable |
| Bloque es `B.PRINT` | Los args de print son strings |
| Bloque es `B.IMPORT` | La línea entera es una ruta |
| Bloque es `B.VAR` | Se declara, no se usa |
| Primer token de `B.FUNC_DEF` o `B.FOR_LOOP` | Es el nombre que se define |
| `value === 'true'` o `value === 'false'` | Literales booleanos |
| `value` está en `keywordSet` | Palabra reservada |
| Raíz en `varRoots` (nativas + known_module_roots) | Variable nativa conocida |
| En `byId` | Entrada conocida del JSON |
| Raíz en `importRoots` | Módulo importado (opaco) |
| Raíz en `declared` | Variable declarada por el usuario |
| Token anterior (no-espacio) es STRING `'.'` y el anterior al `.` NO es `']'` | Método de objeto/variable → opaco |
| Token anterior al `.` ES `']'` y `array.X` existe en `byId` | Método de array literal conocido |
| Bloque tiene `unknown_command` warning | Evita duplicados |

**Si pasa todos los filtros:**
```javascript
block.tokens[i] = [T.UNKNOWN, value]
block.warnings.push(_warnW(W.UNDECLARED_VAR, mensaje))  // severity='warning'
```

## Validaciones individuales

### `_checkConditionExpr(expr)`
Lee de `this.condValidate` (← `?.validate`):
- Expresión no vacía.
- Sin keywords como operandos (`keywordSet`).
- Sin `?` embebido.
- Sin string literal sin operador.
- Sin trailing junk (respeta depth de `()` y `[]`, y RHS multi-palabra).
- Detecta `==` y `=!` → `W.INVALID_OPERATOR`.
- Detecta propiedades inexistentes en sealed_groups → `W.SEALED_PROPERTY`.
- Recoge `_inlineArgWarnings` al final.

### `_checkVarDecl(arg)` — lee de `this.varValidate`
- Nombre cumple `identifier_pattern`.
- No es `reserved_name`.
- Solo una declaración.
- Si valor es `import path` → `_checkImport(path)`.
- `_detectExprJunk(value)`: detecta tokens inesperados (con depth tracking para `()` y `[]`).

### `_checkImport(path)` — lee de `this.importValidate`
- Sin espacios. No vacío. Cumple patrón de ruta.

### `_checkActivate(arg)` — lee de `activate.arg_validation`
- Case-insensitive. Acepta `fixed_values`, `known_ability_ids`, y cualquier valor que cumpla `charset`.

### `_checkArgCount(def, callStr)`
- Cuenta args separados por `,` respetando profundidad de paréntesis.
- Compara con `def.args`: entre required y total.
- No aplica a funciones con `overloads`.

### `_checkArgTypes(def, callStr)` — lee de `this.argTypeRules`
- Solo rechaza **literales del tipo incorrecto**. Las variables siempre pasan.
- `_classifyArgValue`: clasifica el arg como `string`, `number`, `bool`, `variable`, o `null` (expr compleja → skip).

### `_inlineArgWarnings` y `_flushInlineWarnings()`
- Estado mutable temporal en `this`.
- Se llena durante `_tokenizeExpr` cuando se detectan llamadas inline.
- Se recoge con `_flushInlineWarnings()` en: `_checkConditionExpr`, creación de `B.RAW`, y `_parseFuncCall`.
- **Riesgo:** si `_tokenizeExpr` se llama sin `_flushInlineWarnings` posterior, los warnings quedan pendientes y pueden contaminar el siguiente bloque.

---

# 3. EL EDITOR (`index.html`)

## Estructura del DOM

```
#header
  h1 "STONESCRIPT EDITOR"
  #status     → "ok" | "N errors, M avisos" (color según severidad)
  #share-btn  → copia URL+hash al portapapeles

#scroll-wrap
  #highlight  → div con el código coloreado (pointer-events:none, sobre el textarea)
  #input      → textarea transparente (texto invisible, caret visible)

#gutter       → números de línea alineados con #highlight

#wbar         → consola inferior colapsable
  #wbar-hdr
    "Console"
    #wc-err   → "⚠ N" en rojo  (solo errores)
    #wc-warn  → "▲ N" en amarillo (solo warnings)
    #wt       → ▶/▼
  #wlist      → lista de warnings, cada uno clickable (va a la línea)
```

## Sistema de colores

```css
/* Tokens del highlight */
.control      { color: #e0e0e0; font-weight: bold }
.comment      { color: #4e6e4e; font-style: italic }
.continue-op  { color: #666 }
.command      { color: #9acdaa }
.keyword      { color: var(--accent) }    /* azul */
.print        { color: #9acdaa; font-weight: bold }
.variable     { color: #c8c8c8 }
.function     { color: #5ab4d4 }
.operator     { color: #777 }
.number       { color: #c5b07a }
.string       { color: #8a7a6a }
.identifier   { color: #aaa }
.paren        { color: #555 }
.bracket      { color: #555 }
.unknown      { color: #c8a020; text-decoration: underline wavy #c8a020 }

/* Spans de warning en el highlight */
.warning      { color: var(--err); border-bottom: 1px dashed var(--err) }  /* error */
.warning-w    { color: #c8a020;    border-bottom: 1px dashed #c8a020 }      /* warning */

/* Líneas */
.hl-line.warn   { background: rgba(201,107,107,0.10) }  /* líneas con error */
/* Las líneas con undeclared_variable NO tienen fondo — solo el token .unknown */

/* Gutter */
.gn.warn        { color: var(--err) }
.gn.warn-w      { color: #c8a020 }

/* Status */
#status.ok      { color: var(--ok) }
#status.err     { color: var(--err) }
#status.warn    { color: #c8a020 }

/* Consola */
.we             { color: #664444 }          /* fila de error */
.we.ww          { color: #665500 }          /* fila de warning */
.we:hover       { color: var(--err) }
.we.ww:hover    { color: #c8a020 }
```

## Flujo de render (`doRender`)

Llamado via `requestAnimationFrame` (debounced).

```javascript
1. parsedBlocks = parser.parse(code)
   // árbol completo con scope analysis y T.UNKNOWN aplicado

2. warnings = collectWarnings(parsedBlocks, lines)
   // usa b.lineNum (no busca por contenido) para nº de línea exacto
   // cada warning: { line, message, severity }

3. Actualizar UI:
   - #wc-err  → "⚠ N" solo errores
   - #wc-warn → "▲ N" solo warnings
   - #status  → "N errors, M avisos" | "ok"

4. colorLines = renderLineByLine(lines, parsedBlocks)
   // HTML por línea (incluye T.UNKNOWN del árbol analizado)

5. buildHighlight(lines, colorLines)
   // .hl-line.warn si hay errores en esa línea
   // sin fondo si solo hay warnings

6. buildGutter(lines)
   // .gn.warn para errores, .gn.warn-w para warnings

7. buildWarnPanel()
   // lista de .we (error) o .we.ww (warning) clickables
```

## `renderLineByLine(lines, parsedBlocks)` — FUNCIÓN CRÍTICA

El parser aplica `T.UNKNOWN` en `_scopeAnalysis` que trabaja sobre el árbol anidado. El highlight necesita **bloques flat** (uno por línea fuente). Esta función los reconcilia:

```javascript
function renderLineByLine(lines, parsedBlocks) {
  const code = lines.join('\n')

  // 1. Re-parsear para obtener estructura flat (sin scope analysis)
  const rawLines = parser._splitLines(code)
  const rawFlat  = rawLines.map(l => parser._parseLine(l))

  // 2. Construir índice lineNum→block del árbol analizado
  const byLine = new Map()
  ;(function collect(bs) {
    for (const b of bs) {
      if (typeof b.lineNum === 'number' && !byLine.has(b.lineNum))
        byLine.set(b.lineNum, b)
      collect(b.children)
    }
  })(parsedBlocks)

  // 3. Para cada bloque flat, buscar su versión analizada por lineNum ACUMULADO
  let srcLine = 0
  const flatBlocks = rawFlat.map(b => {
    const analysed = byLine.get(srcLine)
    srcLine += b.raw ? b.raw.split('\n').length : 1
    // Si el raw coincide, usar tokens del árbol (que tienen T.UNKNOWN)
    if (analysed && analysed.raw === b.raw) return { ...b, tokens: analysed.tokens }
    return b  // fallback: tokens sin scope analysis
  })

  // 4. Convertir cada bloque flat a HTML, emitiendo una entrada por línea fuente
  const result = []
  for (const b of flatBlocks) {
    if (b.type === 'empty') { result.push(''); continue }
    if (b.raw && b.raw.includes('\n')) {
      // Bloque multilínea (/* */ o ascii): emitir una entrada por línea
      const htmlLines = renderBlocksNoWarnText([b]).split('\n')
      const n = b.raw.split('\n').length
      for (let j = 0; j < n; j++) result.push(htmlLines[j] || '')
    } else {
      result.push(renderBlocksNoWarnText([b]))
    }
  }
  return result
}
```

**Bug conocido:** el matching `analysed.raw === b.raw` falla cuando hay diferencias de normalización entre el bloque del árbol y el bloque flat (tabs, espacios, caracteres especiales). Cuando falla, se usan los tokens sin scope analysis y las variables declaradas aparecen como `T.UNKNOWN` (amarillo) en el highlight, aunque el parser no genere warnings.

## `collectWarnings(parsedBlocks, lines)`

```javascript
function collectWarnings(blocks, lines) {
  const out = []
  ;(function walk(bs) {
    for (const b of bs) {
      if (b.warnings && b.warnings.length) {
        const ln = typeof b.lineNum === 'number' ? b.lineNum : 0
        b.warnings.forEach(w => out.push({
          line: ln,
          message: w.message,
          severity: w.severity || 'error'
        }))
      }
      if (b.children) walk(b.children)
    }
  })(blocks)
  return out
}
```

Usa `b.lineNum` directamente (asignado durante `parse()`). Esto evita el bug anterior de misattribution cuando había dos bloques con el mismo `raw` (ej: dos `return`).

## Autocomplete

**Activación:** en cada evento `input` (cualquier modificación del texto).

**`wordAtCursor()`:**
```javascript
// Extrae la palabra antes del cursor (sin incluir '.')
// Detecta contexto:
{
  word,           // palabra actual sin '.'
  start, end,     // posición en el textarea
  dotCtx,         // true si hay '.' inmediatamente antes
  receiverIsArray // true si antes del '.' hay ']'
}
```

**`triggerAC()`** — filtra el pool según contexto:
- `receiverIsArray` → solo entradas `array.*` (para `[...].X`)
- `dotCtx` (sin array) → entradas que contienen `.` en su id
- Tras `activate ` → solo ability IDs de `activate.arg_validation`
- Resto → todo `acData` (las 374 entradas del JSON)

**`applyAC()`** — inserta según contexto:
- `dotCtx=true` → inserta solo el último segmento del id (`array.Contains` → `Contains`)
- `dotCtx=false` → inserta el id completo

**Comportamiento de teclas:**
| tecla | AC abierto | AC cerrado |
|-------|-----------|-----------|
| `Tab` | aplica selección | abre AC (si hay palabra) / inserta 2 espacios |
| `Enter` | cierra sin aplicar (el Enter inserta nueva línea normalmente) | normal |
| `ArrowUp/Down` | navega la lista | normal |
| `ArrowLeft/Right`, `Home`, `End` | cierra AC | normal |
| `Escape` | cierra AC | normal |
| cualquier otra | no hace nada especial (el evento `input` reabre si procede) | normal |

## Share

El botón `#share-btn` copia al portapapeles:
```
location.href.split('#')[0] + '#' + encodeURIComponent(code)
```
Al cargar la página, `loadFromHash()` decodifica el hash y carga el código en el textarea.

---

## Tarea de revisión

Con los tres archivos adjuntos, busca las siguientes incoherencias:

1. **Bug principal — `renderLineByLine`:** el matching `analysed.raw === b.raw` entre el flat y el árbol analizado falla a veces en el browser (especialmente con variables de `for v:array`). Variables declaradas aparecen en amarillo aunque el parser no genere warnings. Hay que encontrar por qué el `raw` difiere y arreglarlo.

2. **Coherencia JSON ↔ parser:** ¿Lee el parser correctamente todos los datos del JSON que debería? ¿Hay reglas hardcodeadas en el parser que deberían venir del JSON?

3. **Scope analysis — falsos positivos/negativos:** ¿Hay casos donde `_checkBlockIdentifiers` marca como `undeclared` algo que está declarado, o deja pasar algo que no debería?

4. **Estado mutable `_inlineArgWarnings`:** ¿Hay rutas de código donde `_tokenizeExpr` deja warnings en `_inlineArgWarnings` sin que se llame `_flushInlineWarnings` después? ¿Pueden contaminar bloques posteriores?

5. **Tipos de argumento:** ¿Todos los métodos nativos en el JSON tienen `args` con tipos correctos? ¿El parser los valida coherentemente con `arg_type_rules`?
