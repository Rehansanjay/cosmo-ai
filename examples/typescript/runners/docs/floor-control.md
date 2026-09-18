# Floor control: telling a live agent something without cutting it off

Every app driving a realtime agent eventually wants to *tell it something* —
the user scrolled, the record changed, a move was played. The moment you do,
you discover the two sends behave nothing alike, and that the difference is
mechanical rather than stylistic.

This is what we learned building `runners`, with the measurements that produced
each conclusion.

## The two primitives

| | `sendText` | `sendContext` |
| --- | --- | --- |
| Creates a conversation item | yes | yes |
| Asks for a response | **yes** | **no** |
| Can interrupt | **always** | never |
| Answered aloud | yes | no |

`sendText` rides the same channel as audio, so the turn detector reads it as a
**completed user utterance**. That is why it interrupts: it is not "a message
the agent will see", it is "the user just finished saying this, respond."

Injected mid-speech, the turn in progress ends almost immediately and clips
mid-word. It cuts off a speaking human just as fast.

`sendContext` is the opposite by construction. On OpenAI it is
`conversation.item.create` with no `response.create` — the docs are explicit
that *"after adding the user message to the conversation, send the
`response.create` event to initiate a response"*, so an item on its own asks
for nothing.

## Silent context is not universal

A silent channel is not guaranteed by every model behind the API, and the
absence of one is itself silent — there is no error when a note goes nowhere.
Some models accept background context throughout a session; others accept it
only while the session is being set up, and treat anything later as an
utterance to answer.

**If your app depends on streaming live state, confirm the model you are
running actually supports it.** The design below assumes it might not, which
is why the position also rides on the message that asks for a line.

## The floor

Three states, derived from two events:

```
agent   ← agent_state is speaking or thinking
user    ← an interim role:'user' transcript within the last 1.5s
          OR a reply is owed and has not been given
free    ← otherwise
```

The `user` branch needs explaining. `agent_state` reports `listening` **both**
while a person is mid-sentence and while the room is silent — it cannot answer
"is someone talking right now?". Interim transcript deltas can, and they keep
arriving for as long as the utterance does.

**Owed replies matter more than they look.** When someone speaks, they have
earned the next turn. Injecting into that gap makes the agent answer *the app*
instead of *the person* — which reads as the agent ignoring them. So the floor
stays theirs until it has actually spoken, capped so a silent agent cannot
freeze the app.

## State goes with the news, not on its own

The obvious design is to stream the position over `sendContext` and let the
model read it when needed. It does not hold up.

Every push is a `conversation.item.create` — an **append, not a replacement**.
After a few turns the conversation holds a stack of items that each claim to
be the board, contradicting each other, with nothing marking which is current.
A single game can produce dozens. The model reads whichever it likes, and the
failure gets worse the longer the game runs — so pushing *more often* makes it
worse, not better.

Delivery can also lag: a note sent while the agent is talking may not reach it
until the reply finishes, so the board can be several moves behind by the time
it is read.

So the position rides **inline on the message that asks for the line**, in one
line rather than the whole dump. There is exactly one board, it is always the
newest, and it sits in the most recent thing the model read. `sendContext`
remains genuinely useful once, at session start.

## The wait has a ceiling

Waiting for a gap is best effort, not a guarantee, and it deliberately gives
up after a while. A far-field microphone produces a stream of fragments; each
one re-arms the hold, and if they arrive faster than it clears then the floor
never reads as free and held lines are *never* delivered — not late, never.

So a line that has waited long enough goes out regardless. That will sometimes
clip. The alternative is a commentator that goes quiet the moment the room
does anything, which is worse and much harder to diagnose.

## One delta, not a queue

There is no queue of pending messages. There is **one running `delta`** of what
has happened since the agent last spoke, and it grows while the floor is busy.

That single decision removes a surprising amount of machinery: nothing can go
stale (the delta is always current), nothing needs superseding (there is only
one), and nothing needs merging (it was never split). Holding longer simply
means the eventual line covers more ground.

## Asking for a line

Two different asks, and conflating them is why a commentator can feel broken:

- **An event happened** → *"React to this."*
- **The beat came round** → *"Nothing was asked of you. Call the state of play."*

Without the second, the agent only ever speaks when spoken to, which for
anything ambient reads as a fault. Its guard is that the board must actually
have moved, so silence is never filled with invented chatter.

## Two failure modes that look like model failures

**Unattributed injections.** Notes arrive on the same channel as speech. Absent
a line saying otherwise, the model treats them as something a person said and
replies accordingly — *"Where did that come from?"* is a reasonable answer to
an utterance with no speaker. Frame every injection.

**Facts the model must remember rather than read.** Given state on a side
channel and a request on another, it will answer from whatever it heard most
recently and invent the rest. In one session it held a board reading
`Runners: 3@1 4@1` and talked about column 11 three times — the only source of
"eleven" in its entire context was a rules sentence saying *"climb eleven
columns"*, which it read as a column name.

Two fixes, both cheap: **put the facts in the same message that asks for the
line**, and **never write a bare number into a prompt that could be mistaken
for a value in the domain.**

## The agent has no tools

Worth stating plainly, because it is the design and not an omission: the
commentator holds no tools and no skills. The game runs itself, the position is
pushed on every change, and there is nothing for the agent to fetch or move.

An agent that can act is an agent that can stall the thing it is watching —
every move becomes a round-trip, and a dropped turn freezes the game. Taking
the tools away removes that failure mode rather than scheduling around it.

## What is worth reusing

`sender.ts` has no game knowledge. The state machine, the owed-reply rule, the
single-delta model, and the two asks transfer directly to a chess coach, a
dashboard narrator, or a support agent watching a screen share. Only the
wording of the notes is domain-specific.
