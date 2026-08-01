import { toPack, type RulesetPack } from '../../ruleset.ts'
import { BASE_RULES, NEUTRAL_MODULE } from './shared.ts'
import { FACTION as BADGERS } from './badgers.ts'
import { FACTION as HORDE } from './horde.ts'
import { FACTION as COMPACT } from './compact.ts'

// The factions that ship with the game, offered as importable rulesets.
//
// These are the worked examples. Somebody authoring their own faction starts
// by importing one, renaming it, and editing — the same way the built-in
// blueprints are the starting point for authoring a model. They are plain data
// either way, so there is no second copy to keep in step: this list IS what
// the starter maps compose.
//
// Each carries the shared base, so importing one into a blank map brings the
// damage matrix and veterancy ladder its units were balanced against. Import a
// second into the same map and the base is ignored — the map already has one,
// and the module is checked against it instead.
// Each ships the neutral structures as well, because a fortress plot accepts
// the farm and the watchtower — a faction without them is not a game you can
// start, which validateRulesetPack refuses to let a pack claim.
export const BUILTIN_RULESETS: RulesetPack[] = [
  toPack({ id: 'badgers', name: 'Badgers', version: 1, base: BASE_RULES }, [NEUTRAL_MODULE, BADGERS]),
  toPack({ id: 'horde', name: 'The Horde', version: 1, base: BASE_RULES }, [NEUTRAL_MODULE, HORDE]),
  toPack({ id: 'compact', name: 'The Compact', version: 1, base: BASE_RULES }, [NEUTRAL_MODULE, COMPACT]),
]
