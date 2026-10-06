# Doudou v0.2.x — Product Presentation Architecture

> Product-layer design for translating the **already-built** G0–G8 capabilities into a user-facing journey.
> No code changes proposed in this document beyond what is explicitly named in section 8.
> Generated: 2026-10-06 · baseline: HEAD `512830f` (tag `v0.2.0`) + uncommitted v0.2.1 polish (anchor sentence + 29.6 explanation + scenario rename).

---

## 1. Product Presentation Architecture

### User journey (verbatim from spec)

```
现在的家庭状态
   → 我想做一件事
   → 把这件事放进未来看看
   → 看安全垫怎么变化
   → 看有没有越过安全边界
   → 做决定
   → 兜兜记住这个决定
```

### Mapped to product layers

| Layer | Spec name | Answers | State in v0.2 |
|------|------------|----------|---------------|
| **1** | 我的家 / HOME | "我们家现在稳不稳？" | ✅ real screen (`G8_IDLE`) |
| **2** | 试试看 / SCENARIO | "如果发生这件事，会怎么样？" | ✅ reachable via submit (`G8_RESULT` after parse+validate+simulate) |
| **3** | 安全边界 / SAFETY BOUNDARY | "这件事会不会越过我们的安全底线？" | ⚠️ rendered as a badge only (`稳定` / `接近底线` / `跌破底线`); no spatial boundary visual |
| **4** | 我的决定 / DECISION MEMORY | "我最后怎么决定的？" | ⚠️ reachable (`G8_DECISION_RECORDED`); visible only after a decision is recorded |

`CLARIFYING` (`G8_NEED_CLARIFICATION`) and `PARSE_FAILURE` / `VALIDATION_FAILURE` are **transient error screens**, not user-facing layers. They are runtime states, not progressive-disclosure levels.

---

## 2. G0–G8 Translation Matrix

### G0 — HouseholdState domain

| | |
|---|---|
| Current code | typed struct with invariants (`domain_HouseholdState`); persisted as `household.json`; loaded by G1 |
| Product capability | "household memory" — the family profile is durable |
| User question | "兜兜知道我家多大吗？" |
| User sees | (no direct screen); provides substrate for Layers 1, 2, 3 |
| User does | sets up once at first launch / migration |
| Currently expressed in UI | **indirectly**: every IDLE card pulls `h.monthly_income / mortgage / living / liquid_cash / safety_floor_months` from the typed `HouseholdState` |
| If absent | nothing renders |
| Minimum landing | none — already wired |

### G1 — Persistence + Migration

| | |
|---|---|
| Current code | `persist_save_household` / `persist_load_household` (atomic-ish); `persist_migrate_v01_to_v02`; `persist_save_decisions` / `persist_load_decisions` |
| Product capability | "兜兜记得我家" / "兜兜记得我怎么选" |
| User question | "它会不会忘？" |
| User sees | nothing — persistence is silent infrastructure |
| User does | nothing — automatic on every state change |
| Currently expressed in UI | **only as "我记得" header** in IDLE — that header reads as product voice, not as a persistence label |
| If absent | data loss on every restart |
| Minimum landing | none — already wired |

### G2 — Scenario type model

| | |
|---|---|
| Current code | 4 types: `REST` / `CAR_PURCHASE` / `INCOME_CHANGE` / `EXPENSE_CHANGE`; validated via G0 invariant |
| Product capability | "试着看会发生什么" — future projection is type-aware |
| User question | "兜兜能算什么？" |
| User sees | (no direct screen); supplies constraints for G3 / Layer 2 |
| User does | selects a scenario (button or text) |
| Currently expressed in UI | **none** — types are technical labels (`REST` / `CAR_PURCHASE` / `INCOME_CHANGE` / `EXPENSE_CHANGE`) and are not exposed in any widget |
| Minimum landing | none — type model is internal, which is correct (per spec: "不要把 scenario object 暴露给用户") |

### G3 — Deterministic Simulation

| | |
|---|---|
| Current code | `g3_simulate(household, scenario)` returns `{baseline_path, scenario_path, delta, trace}` — both baseline and scenario paths over a shared horizon; non-clamping negative cash |
| Product capability | "29.6 个月 → 23.6 个月" (Layer 2) + delta values (Layer 4) |
| User question | "如果我这么做，会怎么样？" |
| User sees | **only in RESULT page** — big `scenario_buf` number + `baseline X 月 → scenario Y 月` + `cash_delta N 元` |
| User does | clicks a scenario button → reads the result |
| Currently expressed in UI | partial — present but under-communicated (no visual diff between baseline and scenario; no explanation of *why* the number changed; negative cash path is computed correctly but unrendered in current RESULT page) |
| Minimum landing | Layer 4 / Layer 4b — render the **delta visually** (a "before → after" arrow with the new number), render the **reasons** (e.g., `6 × 2.7 万 ≈ 16.2 万`), render the **safety floor overlay** |

### G4 — Safety Boundary classification

| | |
|---|---|
| Current code | `g4_policy_evaluate` classifies into `ok` / `warn` / `danger` with strict `<` thresholds |
| Product capability | "会不会跌破我们的安全底线？" — boundary visibility |
| User question | "做完以后，我们家还能撑多久？" / "会不会跌破底线？" |
| User sees | a single text badge: `稳定` / `接近底线` / `跌破底线` — flat, no spatial layout |
| User does | reads the badge |
| Currently expressed in UI | **insufficient**. A badge is a status indicator, not a safety boundary. Per spec: "不要只做 stable/warn/danger 三个标签" |
| Minimum landing | Layer 3 — render **distance-to-floor** explicitly (e.g., "距底线 11.6 个月"), and **visualize the floor as a line** so the user can see *where* the new buffer sits |

### G5 — Natural language parser

| | |
|---|---|
| Current code | keyword detection + amount/sign/duration extraction; returns `ParsedIntent` / `ClarificationRequest` / `ParseFailure` |
| Product capability | "我直接说就行" — no rigid input format |
| User question | "我必须按按钮吗？" (answer: no) |
| User sees | the **input box** with placeholder `说一句你的情况，不用填表` |
| User does | types natural language and submits |
| Currently expressed in UI | **partial** — the input box is visible; the submit button `听懂了` is named ambiguously ("听懂了" = "I understand", which reads as "兜兜 understood you" — product-friendly but vague) |
| Minimum landing | none — present, working, language layer |

### G6 — Validation + Clarification

| | |
|---|---|
| Current code | `g6_validate` returns `Scenario` / `ClarificationRequest` / `ValidationFailure`; type-specific required-fields and shape rules |
| Product capability | "信息不够时它会问" |
| User question | "如果我说得太少呢？" (answer: 兜兜会问) |
| User sees | **`NEED_CLARIFICATION` screen** with a single question |
| User does | answers the question, types again |
| Currently expressed in UI | ✅ reachable, ✅ question text correct, ⚠️ but uses **technical voice** ("你想休息几个月？" — fine; but missing the rich context of what was missing, e.g., "我知道了——但请告诉我你想休息几个月") |
| Minimum landing | light copy polish on the question prompt; otherwise done |

### G7 — Decision Memory

| | |
|---|---|
| Current code | `g7_record` (validates → appends → caps at 32 → evicts oldest); persists via G1's `persist_save_decisions`; `snapshot` captures **current** household (cash + buffer), NOT scenario horizon |
| Product capability | "我最后怎么决定的？" / "我当时为什么这么决定？" |
| User question | "兜兜记得住我的决定吗？" |
| User sees | **`DECISION_RECORDED` screen** showing choice + snapshot cash + buffer + decision count; one-shot, transient |
| User does | confirms / dismisses the screen |
| Currently expressed in UI | **present but weak**. Screen is a confirmation message, not a *memory*. There is no persistent "memory list" view — no place where the user can *look back* at past decisions, see why they chose, and use it to inform the next scenario |
| Minimum landing | Layer 7 — render a **memory list** in IDLE (or its own panel): last N decisions with snapshot, choice, and timestamp. *This is the most missing product surface today.* |

### G8 — Integration / Orchestrator

| | |
|---|---|
| Current code | `flow_submit_text` / `flow_decide` / `flow_set_screen` + `g8_view_state` + `g8_init` + `g8_on_*` UI handlers + `g8_render_text` (pure helper) |
| Product capability | "完整闭环" — natural input → simulation → decision → memory |
| User question | "兜兜能帮我走完全程吗？" |
| User sees | the full screen-flow sequence |
| User does | everything |
| Currently expressed in UI | ✅ the screens exist; the transitions are wired |
| Minimum landing | the **render contract** must be enriched per Layer 1–4 above |

---

## 3. Screen / State Model

User-facing state model. Distinct from G8's internal state machine (which has 6 states). Some G8 states are real screens; some are purely transient.

| Screen / state | Is this a real user screen? | Why |
|---|---|---|
| **HOME** (IDLE) | ✅ yes — the primary surface | Anchors the whole product |
| **CLARIFYING** (`G8_NEED_CLARIFICATION`) | ✅ yes — user must answer | Visible only after partial input |
| **TRYING** (transient, between submit and RESULT) | ⚠️ no separate screen — but a moment-of-thinking indicator would help | Current code goes IDLE → RESULT immediately; **a 200–500 ms loading beat would communicate "兜兜 is calculating"** without adding a screen |
| **RESULT** (`G8_RESULT`) | ✅ yes — where simulation is consumed | Shows scenario buffer + delta + decision buttons |
| **SAFETY** (visual subset of RESULT) | ⚠️ not a screen — it's a **visual treatment inside RESULT and HOME** | Per spec: distance-to-floor as a line; current buffer vs scenario buffer on a single axis |
| **DECISION** (subset of RESULT) | ⚠️ not a screen — it's the **decision row inside RESULT** | Per spec: 3 buttons (做 / 先不做 / 再等等) |
| **DECISION_RECORDED** (`G8_DECISION_RECORDED`) | ⚠️ **transient confirmation only** | Shows snapshot + choice; should *route back* to HOME / MEMORY after a beat |
| **MEMORY** (the historical list) | ✅ **new screen needed** | HOME should expose the memory list, not just an empty card |
| **PARSE_FAILURE** (`G8_PARSE_FAILURE`) | ✅ yes (low-stakes) | "我没听懂你说的，再试一次？" — but should be inline within HOME, not a separate page |
| **VALIDATION_FAILURE** (`G8_VALIDATION_FAILURE`) | ✅ yes (low-stakes) | "输入有误" — same inline treatment as above |

**Conclusion of state model**: 5 real screens (HOME / CLARIFYING / RESULT / MEMORY / error-in-HOME). The remaining G8 states (DECISION_RECORDED, PARSE_FAILURE, VALIDATION_FAILURE) are **inline within HOME**, not standalone screens.

---

## 4. Progressive Disclosure

Per spec — 7 levels of increasing depth. The user can stop at any level and still get value.

| Level | Content | Visual treatment | When does this surface? |
|-------|---------|-------------------|-------------------------|
| **1. Anchor + safety number** | anchor sentence + `29.6 个月` + `稳定` badge | Big number, big badge; this is the "first impression" | Always at top of HOME |
| **2. Household key parameters** | `底是 12 个月` / `余额 17.6 个月` / `基本开销 2.7 万/月` | Smaller text below Level 1 | Visible at first glance, but user can read past |
| **3. Scenario delta** | `29.6 个月 → 23.6 个月` | Side-by-side or arrow | Surfaces in RESULT |
| **4. Reason** | `6 × 2.7 万 ≈ 16.2 万` (per-month × duration × necessity) | Expandable detail in RESULT | User taps "为什么变化？" — progressive disclosure, not always shown |
| **5. Safety boundary** | floor line + distance-to-floor visual + if-danger: which month breaches | Spatial graphic (a vertical axis) | Always in RESULT; explicit distance text; **never just a badge** |
| **6. Decision** | `做 / 先不做 / 再等等` | Inline action row at bottom of RESULT | Always shown after result |
| **7. Memory** | list of last N decisions with snapshot | Card in HOME below "我记得" | Always visible in HOME |

Levels are **not new screens** — they're disclosure levels within HOME (1, 2, 7) and RESULT (3, 4, 5, 6).

---

## 5. Demo Journey

Using the canonical demo family (42岁 / 月收入4万 / 房贷1.5万 / 生活1.2万 / 现金80万 / 安全底线12月):

| Step | User action | What 兜兜 shows | Layer / Level |
|------|-------------|------------------|---------------|
| 0 | opens app | **HOME L1**: anchor `问兜兜：如果这件事发生，我们家还稳吗？` + `29.6 个月` + `稳定` | L1 |
| 1 | reads on | **HOME L2**: `底是 12 个月` + `余额 17.6 个月` + `基本开销 2.7 万/月` | L2 |
| 2 | notices | **HOME L7**: `我记得` section + last 1–3 decisions (empty for fresh install) | L7 |
| 3 | clicks `休息6个月` | loading beat (proposed) → **RESULT L3**: `29.6 → 23.6` side-by-side + distance-to-floor 11.6 | L3 |
| 4 | taps `为什么变化？` | **RESULT L4**: `6 × 2.7 万 = 16.2 万` | L4 |
| 5 | (no need to tap) | **RESULT L5**: vertical axis with floor line at 12, current dot at 23.6 — **clearly above floor** | L5 |
| 6 | reads badge | badge stays `稳定` (or shows `跌破底线` if 18-month triggered) | (visual reinforcement) |
| 7 | decides | **RESULT L6**: `做下去 / 先留着 / 等一等` row | L6 |
| 8 | clicks `做下去` | loading → **DECISION_RECORDED**: "已记录决定：做下去 (snapshot: 800000, 29.6 月)" | confirmation |
| 9 | (auto-routes or clicks `回到现在`) | back to **HOME** | (state cycle done) |
| 10 | re-opens HOME | **HOME L7** now shows the new decision in memory list | L7 |

This is **one full product loop**. The user experiences the complete journey: state → question → simulation → explanation → boundary → decision → memory → return.

---

## 6. Current UI vs Target UI

### What already exists (good)

| Element | Current location | Spec target |
|---|---|---|
| Anchor sentence | IDLE L1 (v0.2.1 polish) | ✅ matches |
| 29.6 explanation line | IDLE L2 (v0.2.1 polish) | ✅ matches |
| Scenario label rename | IDLE buttons (v0.2.1 polish) | ✅ matches |
| Big buffer number + tag | IDLE L1 | ✅ matches |
| "我记得" family summary | IDLE L2 | ✅ matches |
| 4 scenario buttons | IDLE buttons | ✅ matches |
| Input field + `听懂了` button | Header | ✅ matches |
| Decision buttons in RESULT | RESULT L6 | ✅ matches |
| 3-state policy tag | RESULT L5 / IDLE | ⚠️ partial — tag exists but no boundary visual |

### What's missing (the gap)

| Element | Spec target | Current state | Minimum fix |
|---|---|---|---|
| **Boundary as a spatial line** | L3 / L5 — vertical axis with floor marker | only badge text | render in IDLE + RESULT (Layer 3 / 5) |
| **Baseline → scenario side-by-side** | L3 — two numbers with arrow | only final number shown | render in RESULT |
| **Reason expandable** | L4 — `为什么变化？` with breakdown | absent | render in RESULT as inline-detail |
| **Distance-to-floor text** | L5 — explicit "距底线 X 个月" | only safety floor shown | add Label |
| **Memory list (last N decisions)** | L7 — list in HOME | no list at all | add `vs.decision_count`-driven list rendering in IDLE L7 |
| **Loading beat (200–500 ms)** | TRYING state | absent | add `TRYING` G8 state or in-flow timer |
| **Inline error in HOME** | PARSE/VALIDATION as inline | separate screen | fold error into HOME L1 region |
| **DECISION_RECORDED auto-route** | routes to HOME after ~1s | user must click `回到现在` | auto-route on a timer |

### What can be reused (zero change)

- All G0–G8 functions
- All data fields (no schema changes needed; everything in `vs.simulation_result`, `vs.last_decision.snapshot` is sufficient)
- All calculation (G3 cashflow, G4 thresholds, G7 snapshot semantics — these are already correct)
- All button event handlers (just need different `text:` strings on RESULT buttons)

### What must NOT be touched

- G0 types and invariants (every field is needed for the presentation)
- G1 persistence schema
- G2 scenario type model
- G3 simulation math (already correct)
- G4 boundary classification logic (the result is right; only the rendering is weak)
- G5 parser keywords (don't touch language detection)
- G6 validation rules (don't change "what's invalid")
- G7 snapshot semantics (current state at decision time — already correct per the prior fix)
- G8 flow orchestration (the wiring is correct; rendering is the gap)

---

## 7. Implementation Boundary

Per the constraint "不新增 G9、不修改 G0–G8、不改变数据模型":

| Layer | Where to land | Can stay in `on_render`? | Requires flow change? |
|---|---|---|---|
| L1 anchor + 29.6 + tag | HOME on_render | ✅ already there (v0.2.1) | no |
| L2 base parameters | HOME on_render | ✅ already there | no |
| L3 baseline → scenario | RESULT on_render | ✅ — render needs 2 numbers | no |
| L4 reason breakdown | RESULT on_render | ⚠️ need to compute `duration × nec` — `duration` and `monthly_necessary` already in `vs.scenario_summary` and computed from `h` | no, just compute in render |
| L5 boundary line | HOME + RESULT on_render | ⚠️ need to draw a spatial element (Makepad supports it via `DrawLine` or positioned divs) | no |
| L5 distance-to-floor | HOME + RESULT on_render | ✅ just `fmt_num(buf - safety)` | no |
| L6 decision row | RESULT on_render | ✅ already there | no |
| L7 memory list | HOME on_render | ⚠️ need to read `g7_recent(n)` from inside on_render | **YES** — `on_render` currently doesn't call `g7_recent`. Add a one-line call to populate `vs.recent_decisions` in flow_decide. (This is **state** change, not G0–G8 logic change.) |
| Loading beat | G8 flow | ⚠️ optional; if added, requires a new G8 state `TRYING` | would be a flow change |
| Inline error in HOME | HOME on_render | ✅ render `vs.parse_status` and `vs.validation_error` directly in HOME | no |
| DECISION_RECORDED auto-route | G8 flow | ⚠️ optional — flow_set_screen on timer | would be a flow change |

**What G0–G8 already provides (do not re-derive):**
- `h.monthly_income`, `h.mortgage`, `h.living`, `h.liquid_cash`, `h.safety_floor_months` — all there
- `vs.simulation_result.baseline_path.buffer_at_horizon` — already computed
- `vs.simulation_result.scenario_path.buffer_at_horizon` — already computed
- `vs.simulation_result.scenario_path.cash_at_horizon` — already computed
- `vs.last_decision.snapshot.{cash, buffer_months}` — already captured at decision time
- `vs.decision_count` — already incremented
- `g7_recent(n)` — already implemented (just not called by render)

**Data fields sufficient for ALL layers.** No new fields needed.

---

## 8. Minimal v0.2.x Presentation Upgrade

At most 5 items, ranked by value. All are render-only (no business logic change).

### Priority 1 — RESULT renders baseline → scenario side-by-side (L3)

- **What**: in `G8_RESULT`, render both `baseline_buf` and `scenario_buf` numbers, not just `scenario_buf`. Format: `29.6 → 23.6 个月` with an arrow character or visual separator.
- **Why**: the most important missing piece. Users currently see only the **destination**, not the **journey**. A delta without a "from" is meaningless.
- **Where**: IDLE block 3252–3268, RESULT block 3249–3283.
- **Effort**: 1 line change. No new code.
- **Code change needed**: none — both fields already exist in `vs.simulation_result`.

### Priority 2 — RESULT renders reason breakdown (L4)

- **What**: in `G8_RESULT`, render `duration_months × monthly_necessary` for the scenario. E.g., for REST 6mo: `6 × 2.7 万 ≈ 16.2 万`.
- **Why**: addresses Q2 from the Product Review ("为什么是这个数字"). Without it, the user sees a number change but cannot reverse-engineer it.
- **Where**: inside RESULT block, between L3 (side-by-side) and L6 (decision row).
- **Effort**: 3–4 lines. `scenario_summary.duration_months × nec` is the only computation.
- **Code change needed**: none.

### Priority 3 — HOME shows safety boundary + distance to floor (L5)

- **What**: in IDLE L1 area, show explicit "距底线 17.6 个月" as a clearly-readable number. Optionally: a thin horizontal axis with a floor marker at 12, current position at 29.6.
- **Why**: a badge is not a boundary. Per spec: "应该考虑视觉表达".
- **Where**: IDLE L1 / L2 region. Pure render.
- **Effort**: 1–2 lines for the text; 5–10 lines for the spatial axis.
- **Code change needed**: none.

### Priority 4 — HOME shows memory list (L7)

- **What**: in HOME "我记得" section, render the last 3 decisions from `g7_recent(3)`. Each row: choice + (snapshot cash at decision time + buffer at decision time).
- **Why**: addresses the biggest product gap identified in Review — memory is invisible to user.
- **Where**: HOME on_render, below "我记得" header.
- **Effort**: requires populating `vs.recent_decisions` in `flow_decide` (one field added to view_state, one line in flow_decide).
- **Code change needed**: **YES, but minimal**:
  - add `recent_decisions` field to `g8_view_state` init
  - in `flow_decide`, populate `state.recent_decisions = g7_recent(3)` before assigning `g8_view_state = state`
  - This is **state plumbing**, not business logic. No G0–G8 change.

### Priority 5 — IDLE error inline (no separate screen)

- **What**: in HOME L1 area, if `vs.parse_status == "ParseFailure"` or `vs.validation_error != nil`, render an inline yellow/red banner — not a separate screen.
- **Why**: the user should never lose the HOME anchor. Today, errors route to a full-screen error page.
- **Where**: HOME on_render L1.
- **Effort**: 4–6 lines. Just check view_state and conditionally render.
- **Code change needed**: none — pure render check.

---

## 9. v0.3 Presentation Opportunities

At most 5 items. Distinguish real product capability from visual decoration.

| # | Opportunity | Real product capability? | Visual decoration? | Note |
|---|--------------|--------------------------|--------------------|------|
| v3.1 | **Time-decay memory**: show "你 7 天前做过这个决定" | ✅ yes — temporal context makes memory feel real | no | Needs `created_at` → relative time. `DecisionRecord.created_at` already exists; render computes relative. |
| v3.2 | **Memory as a query**: user can ask "兜兜，我这个月做过什么决定？" and get a list | ✅ yes — full round-trip memory | no | Needs `g7_recent(n)` exposure via G5 parser. Already callable; just needs NL routing. |
| v3.3 | **Scenario follow-up**: after decision, show "如果你当时没做这个决定，现在是 X 个月" (counterfactual on the counterfactual) | ✅ yes — closes the decision loop | no | G3 already computes `baseline_path`; just needs a comparison view. |
| v3.4 | **Gradual re-engagement**: if user opens app after 30+ days, "兜兜注意到你上次决定是 X — 现在情况变了，要重新看看吗？" | ✅ yes — proactive nudge from memory | no | Needs cross-session comparison. New state field, not new business logic. |
| v3.5 | **Animation on key transitions** (countdown from 29.6 to 23.6 when scenario clicked) | no | ✅ yes — pure decoration | Do **not** add unless explicitly requested. Spec says "不要为了'丰富'而堆动画、装饰或无意义卡片". |

**Excluded from v0.3**:
- Charts (折线图、柱状图) — not in spec; adds visual noise without product clarity
- Color theming — current palette is appropriate
- Animations — excluded

---

## 10. Demo Critical Path

For the Demo recording, the user must see exactly **these 5–7 moments** in order:

1. **Open app** → HOME shows `29.6 个月` + `稳定` + anchor sentence. (Demonstrates: 兜兜 knows your household.)
2. **Notice "底是 12 个月" and "余额 17.6 个月"** — they read as natural language, not jargon. (Demonstrates: 兜兜 uses words ordinary people understand.)
3. **Click `休息6个月`** → RESULT shows `29.6 → 23.6 个月` with the **reason** `6 × 2.7 万 = 16.2 万`. (Demonstrates: 兜兜 can predict what happens.)
4. **See the safety floor visualized** — current and scenario buffer are **above** the floor, with distance-to-floor explicitly shown. (Demonstrates: 兜兜 understands safety, not just numbers.)
5. **Choose `做下去`** → MEMORY shows the decision was recorded with its snapshot. (Demonstrates: 兜兜 remembers what you chose.)
6. **Return to HOME** → memory list now includes this decision. (Demonstrates: the loop closes.)
7. **(Optional)** Open a different scenario (e.g., `买辆 30 万的车` → 18.5 月) to demonstrate that 兜兜 handles different events.

**If the Demo recording can only show 3 moments**, prioritize: 1, 3, 5. These three together establish the entire product loop.

---

## Appendix A — Conflicts between v0.2.1 polish and this architecture

Per spec: "如果发现当前 v0.2.1 copy polish 与这个产品表现架构存在冲突，只记录问题，不修改代码。"

| Conflict | Description | Severity |
|---------|-------------|----------|
| None currently | The v0.2.1 polish (anchor / 29.6 explanation / scenario rename) is **fully aligned** with this architecture — it implements L1 and L2 of Layer 1, and the rename in Layer 2. | n/a |

The v0.2.1 polish is a **subset** of what this document proposes. No contradictions.

---

## Appendix B — Known runtime limitation (not in scope)

Per spec: "不做 host / makepad-remote 修复".

`makepad-remote /click` and native click events trigger widget-dispatch in Splash but **Makepad's widget_async panic** on UTF-8 string byte-slicing (specifically inside Chinese `月` character) **prevents the on_click closure from completing**. This is an upstream Makepad runtime bug, **not a Doudou business-logic failure**. All G0–G8 functions execute correctly when invoked directly. Documented; out of scope for v0.2.x presentation work.
