'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { GitBranch, Sun, Moon, Users, EyeOff, ArrowRight } from 'lucide-react'
import { SplitLogo } from '@/components/brand/logo'
import { SplitMark, MARK_VIEWBOX } from '@/components/brand/split-mark'
import { FlowField } from '@/components/hero/flow-field'
import { ThemeToggle } from '@/components/theme-toggle'

/* Viewport width at which the pillar grid collapses to a single column. Shared by
   PAGE_CSS and the split timeline so the card layout and the curtain reach can never
   drift out of sync. */
const PILLAR_STACK_BP = 760

/* How far each half travels from centre, as a fraction of viewport width.
   Wide: leaves the halves flanking the three-column grid, overlapping the outer cards
   slightly so they read as layered behind them.
   Narrow: cards go full width, so the halves are pushed further out to peek down the
   margins instead of hiding uselessly behind an opaque card. */
const CURTAIN_REACH = { wide: 0.36, narrow: 0.46 }

/* How much bigger than their resting size the halves grow once fully open (paint()'s
   `halfScale`). Shared so the live size measurement can divide this back out — without
   it, a half sized to land at 80% of card height at rest would overshoot to ~93% once
   open, since the growth is applied on top. */
const HALF_OPEN_GROWTH = 0.16

/* Clearance kept below the closed mark so it never crowds the bottom of the pin, and
   the floor its resting size will not shrink past on very short windows. */
const MARK_REST_BREATHING_ROOM = 20
const MARK_MIN_REST_HEIGHT = 96

/* ── Page-scoped CSS (sp- prefix, injected once, never leaks) ───── */
const PAGE_CSS = `
/* Glass variables — explicit rgba avoids color-mix() compat issues */
:root {
  --sp-nav-h: 64px;
  /* Scroll distance the split plays over, on top of the pinned viewport. Generous on
     purpose: the timeline finishes inside the first ~58% and the remainder is dwell,
     where the curtains stay parted and the content sits still to be read. */
  --sp-stage-travel: 220vh;
}

@keyframes fadeSlideUp {
  from { opacity:0; transform:translateY(28px); }
  to   { opacity:1; transform:translateY(0); }
}

[data-reveal] {
  opacity:0;
  transform:translateY(32px);
  transition:
    opacity  0.55s ease calc(var(--i,0)*80ms),
    transform 0.55s ease calc(var(--i,0)*80ms);
}
[data-reveal].visible { opacity:1; transform:translateY(0); }

/* ── Nav ── */
.sp-nav {
  width:100%; display:flex; align-items:center; justify-content:space-between;
  padding:0 40px; height:var(--sp-nav-h);
  /* transparent at rest so the nav reads as part of the hero, gains an edge once scrolled */
  border-bottom:0.5px solid transparent;
  background:var(--bg);
  position:sticky; top:0; z-index:50;
  transition:background 0.3s ease, backdrop-filter 0.3s ease, border-color 0.3s ease;
}
.sp-nav.scrolled {
  background:color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter:blur(14px) saturate(1.4);
  -webkit-backdrop-filter:blur(14px) saturate(1.4);
  border-bottom-color:var(--border);
}
.sp-nav-logo {
  flex:1; color:var(--text);
  display:flex; align-items:center; gap:8px; text-decoration:none;
}
.sp-nav-center { display:flex; gap:34px; }
.sp-nav-btn {
  position:relative;
  font-size:13.5px; font-weight:500; color:var(--text-2); letter-spacing:-0.01em;
  background:none; border:none; cursor:pointer; padding:0;
  font-family:inherit; transition:color 0.2s ease;
}
@media (hover:hover) { .sp-nav-btn:hover { color:var(--text); } }
/* Underline is scoped to the centre group so footer links (which reuse .sp-nav-btn) stay plain */
.sp-nav-center .sp-nav-btn::after {
  content:''; position:absolute; left:0; right:0; bottom:-7px; height:1px;
  background:var(--accent); border-radius:1px;
  transform:scaleX(0); transform-origin:center;
  transition:transform 0.32s cubic-bezier(0.65,0,0.35,1);
}
@media (hover:hover) { .sp-nav-center .sp-nav-btn:hover::after { transform:scaleX(1); } }
.sp-nav-center .sp-nav-btn.is-active::after { transform:scaleX(1); }
.sp-nav-center .sp-nav-btn.is-active { color:var(--text); }
.sp-nav-right { flex:1; display:flex; align-items:center; justify-content:flex-end; gap:12px; }
.sp-nav-desktop { display:inline-flex; align-items:center; }
.sp-btn-ghost {
  background:none; border:0.5px solid var(--border);
  border-radius:8px; padding:6px 14px; font-size:13px; font-weight:500;
  color:var(--text); cursor:pointer; font-family:inherit;
  transition:border-color 0.15s, color 0.15s;
}
@media (hover:hover) { .sp-btn-ghost:hover { border-color:var(--accent); color:var(--accent); } }
.sp-btn-cta {
  background:linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%);
  color:#fff; border:none; border-radius:9px;
  padding:9px 18px; font-size:13.5px; font-weight:600; cursor:pointer;
  text-decoration:none; display:inline-flex; align-items:center;
  white-space:nowrap;
  transition:transform 0.25s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.25s ease;
}
@media (hover:hover) { .sp-btn-cta:hover { transform:translateY(-1.5px); box-shadow:0 8px 20px -6px rgba(29,158,117,0.5); } }
.sp-btn-cta:active { transform:translateY(0); }
.sp-ham {
  display:none; background:none; border:0.5px solid var(--border);
  border-radius:8px; width:44px; height:44px; cursor:pointer;
  color:var(--text); align-items:center; justify-content:center;
  transition:background 0.15s, border-color 0.15s;
}
@media (hover:hover) { .sp-ham:hover { background:var(--bg-3); } }
.sp-ham-box { position:relative; width:18px; height:12px; }
.sp-ham-box span {
  position:absolute; left:0; width:100%; height:2px; border-radius:2px; background:currentColor;
  transition:transform 0.55s cubic-bezier(0.65,0,0.35,1), opacity 0.35s ease, top 0.55s cubic-bezier(0.65,0,0.35,1);
}
.sp-ham-box span:nth-child(1) { top:0; }
.sp-ham-box span:nth-child(2) { top:5px; }
.sp-ham-box span:nth-child(3) { top:10px; }
.sp-ham.open .sp-ham-box span:nth-child(1) { top:5px; transform:rotate(45deg); }
.sp-ham.open .sp-ham-box span:nth-child(2) { opacity:0; }
.sp-ham.open .sp-ham-box span:nth-child(3) { top:5px; transform:rotate(-45deg); }
.sp-mmenu {
  position:fixed; inset:0; z-index:49;
  background:color-mix(in srgb, var(--bg) 58%, transparent);
  -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px);
  opacity:0; visibility:hidden; pointer-events:none;
  transition:opacity 0.9s ease-in-out, visibility 0.9s;
}
.sp-mmenu.open { opacity:1; visibility:visible; pointer-events:auto; }
.sp-mmenu-panel {
  position:absolute; top:var(--sp-nav-h); left:0; right:0;
  max-height:calc(100dvh - var(--sp-nav-h)); overflow-y:auto;
  background:var(--bg); border-bottom:0.5px solid var(--border);
  padding:10px 20px 22px; display:flex; flex-direction:column; gap:2px;
  transform:translateY(-24px); opacity:0;
  transition:transform 0.95s cubic-bezier(0.65,0,0.35,1), opacity 0.85s ease-in-out;
}
.sp-mmenu.open .sp-mmenu-panel { transform:translateY(0); opacity:1; }
.sp-mmenu-row {
  display:flex; align-items:center; width:100%; min-height:48px;
  padding:0 12px; background:none; border:none; border-radius:10px;
  font-family:var(--font-inter,'Inter',sans-serif); font-size:16px; font-weight:400; color:var(--text);
  text-align:left; cursor:pointer; transition:background 0.15s, color 0.15s;
}
@media (hover:hover) { .sp-mmenu-row:hover { background:var(--bg-3); color:var(--accent); } }
.sp-mmenu-row:active { background:var(--bg-3); color:var(--accent); }
.sp-mmenu-row:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.sp-mmenu-div { height:0.5px; background:var(--border); margin:10px 4px; }
.sp-mmenu-theme {
  display:flex; align-items:center; justify-content:space-between;
  padding:4px 12px; font-size:14px; font-weight:400; color:var(--text-2); font-family:var(--font-inter,'Inter',sans-serif);
}

/* ── Hero ── */
/* The hero copy and the mark share one sticky-pinned viewport. Scrolling through
   the stage drives a single continuous, reversible timeline: the copy lifts away,
   the mark's two halves separate toward the edges, and the pillar content resolves
   in the gap between them. */
.sp-stage {
  position:relative; background:var(--bg);
  height:calc(100vh + var(--sp-stage-travel));
  /* Start the stage beneath the sticky nav rather than after it. Otherwise the pin
     begins at y=64 and sticks to y=0, so the content lurches up by the nav's height
     over the first 64px of scroll. The pin's own padding-top keeps clear of the nav. */
  margin-top:calc(-1 * var(--sp-nav-h));
}
.sp-stage-pin {
  position:sticky; top:0; height:100vh; overflow:hidden;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:clamp(28px,5vh,60px);
  /* Nav height plus deliberate breathing room, so the headline is not sitting right
     under the bar. measureRest() reads this padding back when sizing the mark, so the
     extra space is accounted for rather than eating into the mark's fit. */
  padding:calc(var(--sp-nav-h) + clamp(18px,4.5vh,60px)) 24px 0;
}
/* Living background, hero only. Sits behind everything in the pin and is faded out by
   paint() on the same beat as the hero copy, so the second section keeps its plain
   background. Explicit z-index on the siblings rather than relying on .sp-hero-inner's
   will-change incidentally creating a stacking context. */
.sp-flow-field {
  position:absolute; inset:0; z-index:0;
  width:100%; height:100%;
  display:block; pointer-events:none;
}
.sp-hero-inner {
  position:relative; z-index:1;
  width:100%; max-width:880px; text-align:center;
  will-change:transform, opacity;
}
.sp-hero-h {
  font-weight:600; letter-spacing:-0.045em; line-height:0.9;
  /* Also capped against viewport height: the pin is exactly 100vh, so on a short
     window the copy and the mark together outgrow it and the headline gets clipped
     under the nav. Width alone is not enough of a constraint here — the width clamp
     alone would reach 146px and blow the pin apart on a laptop screen. */
  font-size:min(clamp(2.875rem,8.6vw,9.125rem), 13vh);
  color:var(--text); text-wrap:balance;
  max-width:15ch; margin-inline:auto;
}
.sp-hero-h span { display:block; }
.sp-hero-h-loud { opacity:0; animation:fadeSlideUp 0.75s 0.05s cubic-bezier(0.22,1,0.36,1) forwards; }
/* The closing line is set quieter than the first, so the type enacts the copy. */
.sp-hero-h-quiet {
  color:var(--text-2);
  opacity:0; animation:fadeSlideUp 0.75s 0.16s cubic-bezier(0.22,1,0.36,1) forwards;
}
.sp-hero-sub {
  font-size:clamp(0.98rem,1.35vw,1.1rem); color:var(--text-2);
  line-height:1.65; max-width:600px; margin:26px auto 0;
  opacity:0; animation:fadeSlideUp 0.75s 0.28s cubic-bezier(0.22,1,0.36,1) forwards;
}
.sp-hero-btns {
  display:flex; gap:12px; flex-wrap:wrap; justify-content:center; margin-top:34px;
  opacity:0; animation:fadeSlideUp 0.75s 0.4s cubic-bezier(0.22,1,0.36,1) forwards;
}
/* .sp-btn-cta is shared with the nav and footer, sized for those tighter contexts.
   Match it to .sp-btn-hero-s here so the two hero buttons read as one pair. */
.sp-hero-btns .sp-btn-cta { padding:14px 30px; font-size:15px; border-radius:11px; }
.sp-btn-hero-s {
  background:transparent; color:var(--text);
  border:1px solid var(--border); border-radius:11px;
  padding:14px 30px; font-size:15px; font-weight:500; cursor:pointer;
  font-family:inherit;
  transition:border-color 0.2s ease, color 0.2s ease, background 0.2s ease,
             transform 0.25s cubic-bezier(0.34,1.56,0.64,1);
}
@media (hover:hover) {
  .sp-btn-hero-s:hover {
    border-color:var(--accent); color:var(--accent);
    background:var(--accent-bg); transform:translateY(-2px);
  }
}
.sp-btn-hero-s:active { transform:translateY(0); }

/* Entrance lives on the wrapper so the scroll timeline owns .sp-mark's transform
   outright — otherwise the keyframe and the inline transform fight each other. */
.sp-mark-wrap {
  position:relative; z-index:1;
  flex:none;
  opacity:0; animation:fadeSlideUp 0.9s 0.52s cubic-bezier(0.22,1,0.36,1) forwards;
}
.sp-mark {
  position:relative;
  /* Sized from the live-measured card row height (measureRest, in the effect below),
     not a guessed viewport-relative value — the open curtains have to visually match
     the cards they frame. The static fallback only shows for the instant before that
     effect runs on mount. */
  width:var(--sp-mark-w, 180px);
  aspect-ratio:228/308; will-change:transform;
}
.sp-mark-half {
  position:absolute; inset:0; width:100%; height:100%; display:block;
  will-change:transform, filter;
}

/* Pillar content, revealed in the gap the halves open up. */
.sp-reveal {
  position:absolute; inset:0; z-index:2;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  padding:var(--sp-nav-h) clamp(24px,15vw,236px) 0;
  pointer-events:none;
}
.sp-reveal.is-live { pointer-events:auto; }
/* Heading and cards scale as one unit so the whole block grows out of the opening
   together, gap included. Opacity lives here too and is run far ahead of the growth:
   it only softens the first instant, and the card backgrounds are solid long before
   the block is wide enough to reach the curtains — fading the block as the reveal
   itself made the backgrounds translucent and the green showed through them. */
.sp-reveal-inner {
  width:100%; display:flex; flex-direction:column; align-items:center;
  opacity:0; transform-origin:center center;
  will-change:transform, opacity;
}
.sp-reveal-h {
  /* Height-capped like the hero: this heading and the card row share the same pinned
     100vh stage, so an unbounded width clamp would push the cards off it. */
  font-size:min(clamp(2rem,4.4vw,3.5rem), 8vh); font-weight:600;
  letter-spacing:-0.04em; line-height:0.96; color:var(--text);
  text-align:center; text-wrap:balance; margin-bottom:clamp(44px,8vh,88px);
}
.sp-pillars {
  display:grid; grid-template-columns:repeat(3,minmax(0,1fr));
  gap:14px; width:100%; max-width:940px;
}
.sp-pillar {
  background:var(--bg-2); border:0.5px solid var(--border);
  border-radius:16px; padding:26px 24px 22px;
  display:flex; flex-direction:column; gap:10px;
  text-align:left; cursor:pointer; font-family:inherit;
  transition:transform 0.3s cubic-bezier(0.22,1,0.36,1),
             border-color 0.25s ease, background 0.25s ease;
}
@media (hover:hover) { .sp-pillar:hover { transform:translateY(-5px); border-color:var(--accent-border); background:var(--bg-3); } }
.sp-pillar:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.sp-pillar-ico { color:var(--accent); display:inline-flex; }
.sp-pillar-t { font-size:1.12rem; font-weight:600; color:var(--text); letter-spacing:-0.02em; }
.sp-pillar-d { font-size:0.9rem; color:var(--text-2); line-height:1.6; }
.sp-pillar-go {
  margin-top:auto; padding-top:12px; font-size:0.8rem; font-weight:600;
  color:var(--accent); display:inline-flex; align-items:center; gap:5px;
  transition:gap 0.25s ease;
}
@media (hover:hover) { .sp-pillar:hover .sp-pillar-go { gap:10px; } }

/* No scrubbing: the stage un-pins and both states stack as ordinary sections.
   The JS timeline bails out to match, so nothing is left mid-transform. */
@media (prefers-reduced-motion: reduce) {
  .sp-stage { height:auto; }
  .sp-stage-pin { position:static; height:auto; overflow:visible; padding-bottom:clamp(48px,8vh,88px); }
  .sp-reveal { position:static; padding:clamp(40px,7vh,72px) 24px 0; pointer-events:auto; }
  .sp-reveal-inner { opacity:1; transform:none; }
  .sp-hero-inner, .sp-mark-wrap { animation:none; opacity:1; }
  .sp-cta-source, .sp-cta-core, .sp-cta-outcome { opacity:1; transform:none; transition:none; }
  .sp-cta-word { opacity:1; transform:none; transition:none; }
  .sp-faq-item { opacity:1; transform:none; transition:none; }
  .sp-cta-input::before { transform:none; transition:none; }
  .sp-cta-branches::before, .sp-cta-branch { opacity:1; transition:none; }
  .sp-cta-payment-token, .sp-cta-core-token, .sp-cta-branch-token, .sp-cta-blade { display:none; }
  .sp-cta-mark .sp-mark-half { transition:none; }
  .sp-cta-mark .sp-mark-lead, .sp-cta-mark .sp-mark-trail { transform:none !important; }
}

/* ── Sections ── */
/* Vertical rhythm is viewport-height based, so the whitespace scales with the screen
   rather than only with its width. Sections carry top padding only and lean on the
   next section's own top padding for separation, which avoids doubled gaps. */
.sp-sec { padding:clamp(90px,14vh,190px) clamp(20px,4vw,64px); }
.sp-sec-alt { background:var(--bg-2); }
.sp-sec-inner { max-width:1240px; margin:0 auto; }
.sp-sec-tag {
  font-size:11px; font-weight:600; text-transform:uppercase;
  letter-spacing:0.12em; color:var(--accent); text-align:center; margin-bottom:10px;
}
/* Heading ladder rule, carried across the page: as size goes up, line-height comes
   down and negative tracking goes up. That density against large padding is what
   reads as spacious. */
.sp-sec-h {
  font-size:clamp(2rem,4.4vw,3.875rem); font-weight:600; color:var(--text);
  text-align:center; letter-spacing:-0.04em; line-height:0.98;
  margin-bottom:14px; text-wrap:balance;
}
.sp-sec-sub {
  font-size:16px; color:var(--text-2); text-align:center;
  max-width:32ch; margin:0 auto clamp(40px,6vh,72px); line-height:1.6;
}

/* ── Routing — hairline rows ──
   Not cards. Each bucket type is a full-width row separated by a hairline, with its
   share, name, one-line summary and detail laid out across three columns. The layout
   is auto-fit, so the columns fold to two and then one as width drops. */
.sp-routing-head {
  display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr));
  gap:clamp(28px,4vw,80px); align-items:end;
  padding-bottom:clamp(36px,5vw,64px);
}
.sp-routing-h {
  margin:0; font-size:clamp(2.125rem,5vw,4.625rem);
  line-height:0.96; letter-spacing:-0.04em; font-weight:600;
  color:var(--text); max-width:17ch; text-wrap:balance;
}
.sp-routing-intro {
  margin:0; max-width:38ch; font-size:16px; line-height:1.6; color:var(--text-2);
}
.sp-rows { border-top:1px solid var(--border); }
.sp-row {
  position:relative;
  display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
  gap:clamp(12px,2vw,40px); align-items:baseline;
  padding:clamp(24px,3vw,40px) 0;
  border-bottom:1px solid var(--border);
  transition:background 0.35s ease;
}
/* Hover is built from transform and background only — no layout properties — so the
   row can animate on the compositor rather than reflowing four siblings. */
.sp-row::before {
  content:''; position:absolute; left:0; top:0; bottom:0; width:2px;
  background:var(--accent); transform:scaleY(0);
  transition:transform 0.45s cubic-bezier(0.22,1,0.36,1);
}
@media (hover:hover) {
  .sp-row:hover::before { transform:scaleY(1); }
  .sp-row:hover { background:var(--accent-bg); }
}
.sp-row-lead {
  display:flex; gap:18px; align-items:baseline;
  transition:transform 0.45s cubic-bezier(0.22,1,0.36,1);
}
@media (hover:hover) { .sp-row:hover .sp-row-lead { transform:translateX(14px); } }
.sp-row-share {
  font-family:var(--font-jetbrains-mono,monospace); font-size:12px;
  color:var(--accent); font-variant-numeric:tabular-nums;
}
.sp-row-t {
  margin:0; font-size:clamp(1.3125rem,2.2vw,1.875rem);
  font-weight:600; letter-spacing:-0.03em; color:var(--text);
}
.sp-row-one { margin:0; font-size:15.5px; color:var(--text); letter-spacing:-0.01em; }
.sp-row-d { margin:0; font-size:14.5px; line-height:1.6; color:var(--text-2); max-width:42ch; }
.sp-row-bar {
  height:4px; background:var(--bg-3); border-radius:999px;
  overflow:hidden; max-width:220px; margin-top:14px;
}
.sp-row-fill { height:100%; background:var(--accent); border-radius:999px; }
.sp-row-cap {
  margin-top:9px; font-family:var(--font-jetbrains-mono,monospace);
  font-size:11.5px; color:var(--text-3); font-variant-numeric:tabular-nums;
}

/* ── Payroll ──
   Editorial two-column rather than a card grid: payroll is one mechanism, not four
   parallel types, so a single worked example carries it better than icon cards. */
.sp-pay-h {
  margin:0; font-size:clamp(2.125rem,5.4vw,5.125rem);
  line-height:0.95; letter-spacing:-0.04em; font-weight:600;
  color:var(--text); max-width:18ch; text-wrap:balance;
}
.sp-pay-grid {
  margin-top:clamp(40px,6vw,88px);
  display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr));
  gap:clamp(28px,4vw,64px); align-items:start;
}
.sp-pay-left {
  display:flex; flex-direction:column; gap:clamp(24px,3vw,40px); padding-top:8px;
}
.sp-pay-intro { margin:0; font-size:16.5px; line-height:1.6; color:var(--text-2); max-width:40ch; }
.sp-pay-facts { list-style:none; margin:0; padding:0; display:grid; gap:1px; }
.sp-pay-fact {
  padding:16px 0; font-size:14.5px; line-height:1.55; color:var(--text-2);
  border-top:1px solid var(--border);
  display:flex; gap:12px; align-items:baseline;
}
.sp-pay-fact::before {
  content:''; flex:none; width:5px; height:5px; border-radius:50%;
  background:var(--accent); transform:translateY(-3px);
}

/* Manifest — a receipt, not a control surface. Nothing here is clickable, so it
   carries no button that would imply an action it cannot perform. */
.sp-pay-card {
  background:var(--bg-2); border:1px solid var(--border);
  border-radius:18px; padding:clamp(20px,2.4vw,32px);
}
.sp-pay-card-top {
  display:flex; align-items:baseline; justify-content:space-between;
  gap:16px; padding-bottom:16px; border-bottom:1px solid var(--border);
}
.sp-pay-card-t { font-size:14px; font-weight:500; color:var(--text); }
.sp-pay-card-l {
  font-family:var(--font-jetbrains-mono,monospace); font-size:11.5px;
  color:var(--text-3); letter-spacing:0.06em;
}
.sp-pay-line {
  display:grid; grid-template-columns:1fr auto auto;
  gap:14px; align-items:baseline;
  padding:14px 0; border-bottom:1px solid var(--border);
  font-family:var(--font-jetbrains-mono,monospace); font-size:12.5px;
  font-variant-numeric:tabular-nums;
  transition:background 0.25s ease;
}
@media (hover:hover) {
  .sp-pay-card:hover .sp-pay-line { background:transparent; }
  .sp-pay-line:hover { background:var(--accent-bg); }
}
.sp-pay-to { color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sp-pay-kind { color:var(--text-3); }
.sp-pay-amt { color:var(--text); }
.sp-pay-tick { color:var(--accent); }
.sp-pay-foot {
  padding-top:16px; font-family:var(--font-jetbrains-mono,monospace);
  font-size:11.5px; letter-spacing:0.06em; color:var(--text-3);
}

/* ── Privacy ──
   Alternating full-width rows, each split into two halves that meet flush in the
   middle. The halves are filled surfaces at different tones — that contrast is what
   separates them, standing in for the photography the reference layout uses. An
   earlier attempt floated a bare icon at one page margin and the text at the other,
   which left a dead void down the centre of every row. */
/* ── Privacy ──
   The section argues by demonstration rather than decoration. A legible explorer
   readout sits at its centre with nothing redacted, because nothing about a stealth
   payment is hidden; below it a dashed connector runs toward the pay handle and stops
   short. The concealment is rendered as an absence, which is literally what the
   mechanism does: it removes a link, it does not obscure data.
   Heading is left-aligned to match Routing and Payroll. */
.sp-priv-h {
  margin:0; font-size:clamp(2.125rem,5.4vw,5.125rem);
  line-height:0.95; letter-spacing:-0.04em; font-weight:600;
  color:var(--text); max-width:16ch; text-wrap:balance;
}
.sp-priv-intro {
  margin:18px 0 0; font-size:16.5px; line-height:1.6;
  color:var(--text-2); max-width:46ch;
}

/* The artifact. Centred against a left-aligned header on purpose: Payroll already
   owns the side-by-side header-plus-panel composition, so repeating it here would
   make the two sections read as the same layout twice. */
.sp-priv-proof {
  max-width:460px; margin:clamp(44px,6vw,80px) auto 0;
}
.sp-priv-proof-cap {
  font-family:var(--font-jetbrains-mono,monospace);
  font-size:11.5px; color:var(--text-3); margin:0 0 10px;
}
.sp-priv-ledger {
  margin:0;
  background:var(--bg); border:0.5px solid var(--border);
  border-radius:12px; padding:16px 18px;
  font-family:var(--font-jetbrains-mono,monospace); font-size:12.5px;
  font-variant-numeric:tabular-nums;
}
.sp-priv-field {
  display:flex; justify-content:space-between; align-items:center;
  gap:16px; padding:7px 0;
}
.sp-priv-field + .sp-priv-field.is-last {
  border-top:0.5px solid var(--border); margin-top:5px; padding-top:12px;
}
.sp-priv-key { color:var(--text-3); }
/* dd carries a default margin-inline-start in every browser; clear it. */
.sp-priv-val { margin:0; color:var(--text); word-break:break-all; }
.sp-priv-val.is-subject { color:var(--accent); }

/* The severed connector. Height animates because the drawing is the explanation:
   it reaches toward the handle and stops, which is the point being made. */
.sp-priv-cut { display:flex; flex-direction:column; align-items:center; padding-top:14px; }
.sp-priv-cut-line {
  width:0; height:30px; border-left:1px dashed var(--accent-border);
  transform:scaleY(0); transform-origin:top;
  transition:transform 0.7s cubic-bezier(0.22,1,0.36,1);
}
[data-reveal].visible .sp-priv-cut-line { transform:scaleY(1); }
.sp-priv-cut-note { font-size:12px; color:var(--text-3); margin:10px 0 0; text-align:center; }
.sp-priv-handle {
  margin-top:12px; align-self:center;
  font-family:var(--font-jetbrains-mono,monospace); font-size:12.5px;
  color:var(--text-3); border:0.5px dashed var(--border);
  border-radius:8px; padding:7px 14px;
}

/* Plain hairline rows: the artifact above is the section's visual moment, so the
   detail underneath stays quiet rather than competing with it. */
.sp-priv-rows { margin-top:clamp(40px,5vw,68px); border-top:0.5px solid var(--border); }
.sp-priv-row {
  display:grid; grid-template-columns:minmax(0,200px) minmax(0,1fr);
  gap:clamp(16px,3vw,48px); align-items:baseline;
  padding:clamp(18px,2.4vw,26px) 0;
  border-bottom:0.5px solid var(--border);
  transition:background 0.3s ease;
}
@media (hover:hover) { .sp-priv-row:hover { background:var(--accent-bg); } }
.sp-priv-t { margin:0; font-size:16px; font-weight:600; letter-spacing:-0.02em; color:var(--text); }
.sp-priv-d { margin:0; font-size:14.5px; line-height:1.6; color:var(--text-2); max-width:52ch; }

/* ── FAQ ── */
/* ── FAQ ──
   Centred header, unlike Routing / Payroll / Privacy, so the page reads as winding
   down rather than presenting a fourth pillar. */
.sp-faq-h {
  margin:0; font-size:clamp(2rem,4.4vw,3.875rem);
  line-height:0.98; letter-spacing:-0.04em; font-weight:600;
  color:var(--text); text-align:center; text-wrap:balance;
}
.sp-faq-sub {
  margin:18px auto 0; font-size:16.5px; line-height:1.6;
  color:var(--text-2); max-width:44ch; text-align:center;
}
.sp-faq-wrap {
  max-width:640px; margin:clamp(40px,5vw,72px) auto 0;
  border-top:0.5px solid var(--border);
}
.sp-faq-wrap[data-reveal] { opacity:1; transform:none; transition:none; }
.sp-faq-item {
  border-bottom:0.5px solid var(--border);
  opacity:0; transform:translateY(18px);
  transition:opacity 0.42s ease-out calc(var(--i,0) * 70ms),
             transform 0.42s cubic-bezier(0.23,1,0.32,1) calc(var(--i,0) * 70ms);
}
.sp-faq-wrap.visible .sp-faq-item { opacity:1; transform:translateY(0); }
.sp-faq-q {
  display:flex; justify-content:space-between; align-items:center;
  cursor:pointer; padding:22px 0; gap:20px;
  font-size:clamp(1rem,1.5vw,1.25rem); font-weight:500; letter-spacing:-0.02em;
  color:var(--text); user-select:none;
  background:none; border:none; width:100%; text-align:left;
  font-family:inherit; transition:color 0.2s ease;
}
@media (hover:hover) { .sp-faq-q:hover { color:var(--accent); } }

/* Two strokes rather than a "+" glyph: a text plus cannot become a minus, it can only
   spin. Hiding one stroke while the pair turns actually resolves into a minus. */
.sp-faq-icon {
  position:relative; flex:none; width:14px; height:14px;
  transition:transform 0.34s cubic-bezier(0.77,0,0.175,1);
}
.sp-faq-icon::before, .sp-faq-icon::after {
  content:''; position:absolute; background:var(--text-2);
  transition:background 0.2s ease, opacity 0.34s cubic-bezier(0.77,0,0.175,1);
}
.sp-faq-icon::before { top:6.25px; left:0; width:14px; height:1.5px; }
.sp-faq-icon::after { left:6.25px; top:0; width:1.5px; height:14px; }
@media (hover:hover) { .sp-faq-q:hover .sp-faq-icon::before, .sp-faq-q:hover .sp-faq-icon::after { background:var(--accent); } }
.sp-faq-item.is-open .sp-faq-icon { transform:rotate(180deg); }
.sp-faq-item.is-open .sp-faq-icon::after { opacity:0; }

/* Animating grid-template-rows from 0fr to 1fr, not max-height. A max-height
   transition has to guess a cap: set it low and long answers clip, set it high and the
   easing curve spends most of its duration crossing empty space, which is exactly what
   made the old one feel like it snapped open then stalled. 0fr to 1fr resolves against
   the content's real height, so the curve maps to the distance actually travelled and
   every answer takes the same time regardless of length. */
.sp-faq-a {
  display:grid; grid-template-rows:0fr;
  transition:grid-template-rows 0.34s cubic-bezier(0.77,0,0.175,1);
}
.sp-faq-item.is-open .sp-faq-a { grid-template-rows:1fr; }
/* The grid row is the animated track, so this child does the clipping. min-height:0
   stops it claiming its content height, which would defeat the 0fr outright. */
.sp-faq-a-inner {
  overflow:hidden; min-height:0;
  opacity:0; visibility:hidden;
  /* visibility flips only after the collapse finishes, so a closed answer leaves the
     accessibility tree instead of being read out while measuring zero pixels. */
  transition:opacity 0.24s ease, visibility 0s linear 0.34s;
}
.sp-faq-item.is-open .sp-faq-a-inner {
  opacity:1; visibility:visible;
  transition:opacity 0.24s ease, visibility 0s;
}
.sp-faq-a-inner p {
  margin:0; padding:0 32px 24px 0; max-width:none;
  font-size:15px; line-height:1.7; color:var(--text-2);
}

/* ── Closing CTA: one payment resolving into Split's three outcomes ── */
.sp-cta-sec {
  position:relative; overflow:hidden; padding:clamp(90px,14vh,190px) clamp(20px,4vw,64px);
  background:var(--bg-2); border-top:0.5px solid var(--border); border-bottom:0.5px solid var(--border);
  display:flex; align-items:center;
}
.sp-cta-box { width:100%; max-width:1240px; margin:0 auto; display:grid; grid-template-columns:minmax(0,0.9fr) minmax(0,1.1fr); gap:88px; align-items:center; }
.sp-cta-h { margin:0; display:flex; flex-direction:column; gap:14px; font-size:52px; font-weight:600; line-height:1; letter-spacing:0; color:var(--text); }
.sp-cta-line { display:flex; flex-wrap:wrap; gap:0.22em; }
.sp-cta-line:nth-child(3) { color:var(--text-2); }
.sp-cta-word { display:inline-block; }
.sp-cta-statement { max-width:39ch; margin:30px 0 0; font-size:16px; line-height:1.65; color:var(--text-2); }
.sp-cta-flow {
  display:grid; grid-template-columns:120px minmax(36px,1fr) 80px 120px 170px;
  align-items:center; min-height:280px; min-width:0; padding:44px 38px;
  background:color-mix(in srgb, var(--bg) 72%, transparent);
  border:1px solid var(--border); border-radius:8px;
  backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
  box-shadow:0 24px 70px rgba(0,0,0,0.14), inset 0 1px rgba(255,255,255,0.04);
}
.sp-cta-source {
  opacity:1; transform:none;
}
.sp-cta-source-k { font-family:var(--font-jetbrains-mono,monospace); font-size:11px; color:var(--text-3); }
.sp-cta-source-v { display:flex; align-items:baseline; gap:7px; margin-top:8px; color:var(--text); }
.sp-cta-source-v strong { font-size:21px; font-weight:600; letter-spacing:0; }
.sp-cta-source-v span { font-size:12px; color:var(--text-2); }
.sp-cta-input { position:relative; height:2px; margin:0 12px; background:rgba(95,244,157,0.22); overflow:visible; }
.sp-cta-input::before {
  content:''; position:absolute; inset:0; background:var(--accent);
  transform:scaleX(0); transform-origin:left;
  transition:transform 1.25s 0.35s linear;
}
.sp-cta-payment-token, .sp-cta-branch-token {
  position:absolute; width:10px; height:10px; border-radius:50%;
  background:var(--accent); box-shadow:0 0 0 5px rgba(95,244,157,0.1);
}
.sp-cta-payment-token { left:0; top:-4px; opacity:0; }
@keyframes spCtaPaymentTravel {
  0% { left:0; opacity:0; transform:scale(0.75); }
  8% { opacity:1; transform:scale(1); }
  88% { opacity:1; transform:scale(1); }
  100% { left:calc(100% - 4px); opacity:0; transform:scale(0.8); }
}
.sp-cta-flow.visible .sp-cta-input::before { transform:scaleX(1); }
.sp-cta-flow.visible .sp-cta-payment-token { animation:spCtaPaymentTravel 1.35s 0.35s linear forwards; }
.sp-cta-core { position:relative; display:flex; align-items:center; justify-content:center; }
.sp-cta-core-token { position:absolute; z-index:4; left:-10px; top:calc(50% - 5px); width:10px; height:10px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 6px rgba(95,244,157,0.1); opacity:0; }
@keyframes spCtaCoreTravel {
  0% { left:-8px; opacity:0; transform:scale(0.8); }
  15% { opacity:1; transform:scale(1); }
  82% { opacity:1; transform:scale(1); }
  100% { left:calc(100% + 2px); opacity:0; transform:scale(0.75); }
}
.sp-cta-flow.visible .sp-cta-core-token { animation:spCtaCoreTravel 0.68s 1.42s linear forwards; }
.sp-cta-mark { position:relative; width:68px; aspect-ratio:228/308; }
/* Start almost closed; finish at transform:none, which is the exact source-logo geometry. */
.sp-cta-mark .sp-mark-lead { transform:translate(1.5px,1px); }
.sp-cta-mark .sp-mark-trail { transform:translate(-1.5px,-1px); }
.sp-cta-mark .sp-mark-half { transition:transform 0.68s 2.02s cubic-bezier(0.77,0,0.175,1); }
.sp-cta-flow.visible .sp-cta-mark .sp-mark-lead,
.sp-cta-flow.visible .sp-cta-mark .sp-mark-trail { transform:none; }
.sp-cta-blade { position:absolute; z-index:3; left:50%; top:50%; width:2px; height:118px; background:#fff; box-shadow:0 0 16px rgba(95,244,157,0.85); opacity:0; pointer-events:none; }
@keyframes spCtaBladeCut {
  0% { opacity:0; transform:translate(-50%,-75%) rotate(35deg); }
  18% { opacity:1; }
  75% { opacity:1; }
  100% { opacity:0; transform:translate(-50%,-25%) rotate(35deg); }
}
.sp-cta-flow.visible .sp-cta-blade { animation:spCtaBladeCut 0.62s 1.68s cubic-bezier(0.77,0,0.175,1) forwards; }
.sp-cta-branches { position:relative; height:330px; display:grid; grid-template-rows:repeat(3,1fr); }
.sp-cta-branches::before {
  content:''; position:absolute; left:32px; top:calc(100% / 6); bottom:calc(100% / 6); width:2px; background:var(--accent);
  opacity:1;
}
.sp-cta-branch { position:relative; align-self:center; width:100%; height:2px; background:var(--accent); }
.sp-cta-branch-token { left:0; top:-4px; opacity:0; }
@keyframes spCtaBranchTravel {
  0% { left:0; opacity:0; transform:scale(0.75); }
  10% { opacity:1; transform:scale(1); }
  88% { opacity:1; transform:scale(1); }
  100% { left:calc(100% - 4px); opacity:0; transform:scale(0.8); }
}
.sp-cta-flow.visible .sp-cta-branch-token { animation:spCtaBranchTravel 1.05s 2.72s linear forwards; }
.sp-cta-outcomes { display:grid; grid-template-rows:repeat(3,1fr); height:330px; }
.sp-cta-outcome {
  display:grid; grid-template-columns:44px 1fr; align-items:center; gap:14px;
  opacity:1; transform:none;
}
.sp-cta-outcome-ico { width:44px; height:44px; display:grid; place-items:center; border:1px solid var(--border); border-radius:9px; color:var(--accent); background:var(--bg); }
.sp-cta-outcome strong { display:block; font-size:17px; font-weight:650; color:var(--text); }
.sp-cta-outcome-d { display:block; margin-top:5px; font-size:14px; line-height:1.4; color:var(--text-2); }
.sp-cta-actions { display:flex; justify-content:flex-start; margin-top:32px; }

/* ── Footer ── */
.sp-footer { background:var(--bg-3); border-top:0.5px solid var(--border); padding:52px clamp(20px,4vw,64px) 36px; }
.sp-footer-inner {
  max-width:1240px; margin:0 auto;
  display:grid; grid-template-columns:2.2fr 0.9fr 1fr 1.1fr; gap:40px;
  align-items:start;
}
.sp-f-logo { display:flex; align-items:center; }
.sp-f-tag { font-size:13px; color:var(--text-2); margin-top:14px; line-height:1.65; max-width:220px; }
.sp-f-col { display:flex; flex-direction:column; }
.sp-f-col-head {
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:11px; font-weight:600; letter-spacing:0.06em;
  color:var(--text-3); margin-bottom:18px;
}
.sp-f-links { display:flex; flex-direction:column; gap:11px; }
.sp-f-links .sp-nav-btn { font-size:13px; color:var(--text-2); text-align:left; transition:color 0.15s; }
@media (hover:hover) { .sp-f-links .sp-nav-btn:hover { color:var(--text); } }
.sp-f-network { display:flex; flex-direction:column; gap:10px; }
.sp-f-network p,.sp-f-network a { font-size:13px; color:var(--text-2); text-decoration:none; }
.sp-f-network a { color:var(--accent); }
@media (hover:hover) { .sp-f-network a:hover { opacity:0.8; } }
.sp-footer-bot {
  max-width:1240px; margin:36px auto 0;
  padding-top:20px; border-top:0.5px solid var(--border);
  display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;
}
.sp-footer-bot span { font-size:12px; color:var(--text-3); }

/* ── Focus-visible (keyboard navigation) ── */
.sp-nav-btn:focus-visible,
.sp-btn-ghost:focus-visible,
.sp-ham:focus-visible,
.sp-btn-hero-s:focus-visible,
.sp-faq-q:focus-visible {
  outline:2px solid var(--accent); outline-offset:3px;
}
.sp-btn-cta:focus-visible {
  outline:2px solid #fff; outline-offset:3px;
}

/* ── Responsive ── */
@media(max-width:900px){
  .sp-cta-box { grid-template-columns:1fr; gap:76px; }
  .sp-cta-left { max-width:620px; }
  .sp-cta-flow { width:100%; max-width:600px; justify-self:center; grid-template-columns:110px minmax(32px,1fr) 72px 105px 165px; }
  .sp-cta-branches, .sp-cta-outcomes { height:252px; }
  .sp-footer-inner { grid-template-columns:1fr 1fr; gap:40px; }
  .sp-footer-inner > div:first-child { grid-column:1/-1; }
}
@media(max-width:640px){
  .sp-nav-center { display:none; }
  .sp-nav-desktop { display:none; }
  .sp-ham { display:flex; }
  /* Rows fold to a single column; the share number and name stay on one line. */
  .sp-row { gap:10px; }
  .sp-row-d { max-width:none; }
  /* Two halves cannot hold their own beside each other at this width, so the row
     stacks. Alternation is switched off with it — mirrored rows would otherwise put
     the art below the text on every second row, breaking the vertical rhythm. */
  /* Label above description rather than beside it: a 200px label column leaves the
     description too narrow to read at this width. */
  .sp-priv-row { grid-template-columns:1fr; gap:6px; }
  .sp-priv-field { font-size:11.5px; gap:10px; }
  .sp-footer-inner { grid-template-columns:1fr; gap:40px; }
  .sp-footer-bot { flex-direction:column; align-items:flex-start; }
  .sp-f-tag { max-width:none; }
  .sp-cta-sec { padding:64px 20px; }
  .sp-cta-box { gap:64px; }
  .sp-cta-h { font-size:40px; gap:12px; }
  .sp-cta-statement { margin-top:24px; }
  .sp-cta-flow { display:flex; flex-direction:column; min-height:0; padding:32px 20px; }
  .sp-cta-source { text-align:center; }
  .sp-cta-source-v { justify-content:center; }
  .sp-cta-input { width:1px; height:58px; margin:22px 0; }
  .sp-cta-input::before { transform:scaleY(0); transform-origin:top; }
  .sp-cta-flow.visible .sp-cta-input::before { transform:scaleY(1); }
  .sp-cta-payment-token { left:-3.5px; top:0; }
  @keyframes spCtaPaymentTravelMobile {
    0% { top:0; opacity:0; transform:scale(0.75); }
    8% { opacity:1; transform:scale(1); }
    88% { opacity:1; transform:scale(1); }
    100% { top:calc(100% - 4px); opacity:0; transform:scale(0.8); }
  }
  .sp-cta-flow.visible .sp-cta-payment-token { animation-name:spCtaPaymentTravelMobile; }
  .sp-cta-mark { width:48px; }
  .sp-cta-branches { display:none; }
  .sp-cta-outcomes { width:100%; max-width:360px; height:auto; grid-template-columns:repeat(3,minmax(0,1fr)); grid-template-rows:1fr; gap:8px; margin-top:38px; }
  .sp-cta-outcome { display:flex; flex-direction:column; gap:8px; padding:0; text-align:center; }
  .sp-cta-outcome-d { display:none; }
  .sp-cta-actions { margin-top:28px; }
  .sp-sec { padding:64px 20px; }
  .sp-nav { padding:0 20px; }
  .sp-stage-pin { padding-top:calc(var(--sp-nav-h) + 12px); padding-left:20px; padding-right:20px; }
  .sp-hero-btns { flex-direction:column; gap:12px; margin-top:26px; }
  .sp-hero-btns .sp-btn-cta { justify-content:center; width:100%; height:54px; border-radius:14px; font-size:16px; }
  .sp-btn-hero-s { width:100%; height:54px; border-radius:14px; display:flex; justify-content:center; align-items:center; font-size:16px; }
  /* Section header to content gap, doubled from desktop's clamp() floor for mobile only. */
  .sp-routing-head { padding-bottom:72px; }
  .sp-pay-grid { margin-top:80px; }
  .sp-priv-proof { margin:88px auto 0; }
  .sp-faq-wrap { margin:80px auto 0; }
}
@media(max-width:${PILLAR_STACK_BP}px){
  .sp-reveal-h { margin-bottom:28px; }
  .sp-pillars { grid-template-columns:1fr; gap:10px; max-width:300px; }
  .sp-pillar { padding:18px 18px 16px; gap:7px; }
  .sp-pillar-d { font-size:0.85rem; }
  .sp-pillar-go { padding-top:8px; }
  .sp-reveal { padding-left:20px; padding-right:20px; }
}
`

/* ── Static data ─────────────────────────────────────────────────── */

/* Single source of truth for nav, mobile menu, footer links and scroll-spy.
   `id` must match the corresponding <section id="…">. */
const NAV_LINKS = [
  { id: 'routing', label: 'Routing' },
  { id: 'payroll', label: 'Payroll' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'faq',     label: 'FAQ' },
] as const

/* The three pillars, resolved in the gap the split opens.
   `id` matches the section each card jumps to. */
const PILLARS = [
  {
    id: 'routing', label: 'Routing', icon: <GitBranch size={22} />,
    body: 'Buckets with percentages. Every deposit splits across them in the same transaction.',
  },
  {
    id: 'payroll', label: 'Payroll', icon: <Users size={22} />,
    body: 'One signature pays an entire list of recipients, in the same block.',
  },
  {
    id: 'privacy', label: 'Privacy', icon: <EyeOff size={22} />,
    body: 'Stealth links, a Private Vault, generated bucket wallets. Not plainly visible.',
  },
]

/* Illustrative batch shown in the payroll manifest. Deliberately mixes fixed USDC
   amounts with percentage recipients, and wallet addresses with Split handles, since
   that combination is the point being demonstrated. */
const PAYROLL_BATCH = [
  { to: 'alex.split',     kind: 'fixed', amount: '1,200.00' },
  { to: '0x9F2b…c1a4',    kind: 'fixed', amount: '800.00' },
  { to: 'design.split',   kind: '15%',   amount: '600.00' },
  { to: 'treasury.split', kind: '35%',   amount: '1,400.00' },
]

const PAYROLL_FACTS = [
  'One signature pays the whole batch, no separate transaction per person.',
  'Mix fixed USDC amounts and percentage splits in the same batch.',
  'Recipients can be raw wallet addresses or other Split handles.',
  'Every batch is recorded: who was paid, how much, and when.',
]

/* Wording here is deliberately narrow, and checked against the implementation rather
   than written from the general properties of the standard. StealthPayGateway.sol
   publishes the payer, the amount and the stealth address on-chain, so nothing about a
   stealth payment is concealed. What is absent is any on-chain record tying the
   receiving address to the recipient's handle. An earlier draft claimed the amount and
   sender were hidden, which would have been false on the page's own contract. */
const PRIVACY_FEATURES = [
  {
    t: 'Stealth pay links',
    d: 'One link. Every payment lands at a fresh address, and no on-chain record ties it back to your handle.',
  },
  {
    t: 'Private Vault',
    d: 'An address only your own signature can derive. Held balances go here, never to your public wallet.',
  },
  {
    t: 'Generated bucket wallets',
    d: 'Give any bucket its own Split-derived wallet. Sending from it is signed locally on your device.',
  },
  {
    /* Both modes are named because they genuinely differ: quickClaim() calls the Split
       contract and links the address to the account, privateClaim() transfers straight
       to bucket destinations and never does. Presenting only one would misdescribe it. */
    t: 'Two ways to claim',
    d: 'Quick costs less gas but links that address to your account. Private fans the payment straight out to your buckets, so no single transaction connects the two.',
  },
]

/* Every answer is checked against the contracts rather than written from how the
   product is described elsewhere. Specifics worth keeping accurate if these are ever
   edited: Split.sol declares MAX_BUCKETS = 10 and reverts a deposit unless the user's
   buckets sum to BPS_TOTAL exactly; it has no owner, admin, pause, upgrade or proxy
   path of any kind, which is what makes the custody answer literally true rather than
   a figure of speech. The privacy answer states the limits plainly because
   StealthPayGateway.sol publishes the payer and the amount on-chain, so any claim that
   a stealth payment hides them would be false. */
const FAQS = [
  {
    q: 'Is Split custodial?',
    a: 'No. Your USDC sits in an open smart contract, not with Split or any company. There is no owner, no admin key and no pause switch, because the contract has no privileged functions at all. It can only ever move funds to destinations you set yourself.',
  },
  {
    q: 'Does the person paying me need a Split account?',
    a: 'No. They open your pay link, connect any EVM wallet holding USDC on Arc, and pay. They never sign up for anything, and they never touch the Split interface.',
  },
  {
    q: 'What happens the moment a payment arrives?',
    a: 'It splits across your buckets inside the same transaction. You can have up to 10 buckets and they have to total exactly 100%, otherwise the contract rejects the deposit rather than guessing what you meant.',
  },
  {
    q: 'How does batch payroll work?',
    a: 'Add every recipient once, as a wallet address or a Split handle, with either a fixed USDC amount or a percentage. You sign a single time and everyone is paid in the same transaction, in the same block.',
  },
  {
    q: 'Is a stealth payment actually private?',
    a: 'Partly, and the distinction matters. The sender and the amount are public on-chain exactly like any other transfer. What stays private is which address belongs to you: nothing on-chain connects the receiving address to your pay link. Timing and amount patterns can still narrow it down, so treat it as unlinked, not untraceable.',
  },
  {
    q: 'What is the Private Vault?',
    a: 'An address derived from a signature only your wallet can produce. It is never stored anywhere, just recomputed when you unlock it. Held bucket balances are claimed into it instead of your public wallet. Because it is reused, moving it to your main wallet would link the two, so Split never does that on its own.',
  },
]

/* The four bucket types, one hairline row each. `share` is the illustrative split
   percentage; `progress` is only set on the type that demonstrates a savings target. */
const BTYPES = [
  {
    share: '40%', t: 'Auto-sends',
    one: 'Sends the moment USDC arrives.',
    d: "Set a destination wallet. Every deposit pushes that bucket's share there immediately, no manual step, no delay, same transaction.",
  },
  {
    share: '30%', t: 'Holds',
    one: 'Accumulates until you are ready.',
    d: 'Funds stay in the Split contract under your address. Withdraw any amount, to any wallet, at any time.',
  },
  {
    share: '20%', t: 'Goal',
    one: 'Tracks your savings target.',
    d: 'Attach a target to any hold bucket. A progress bar fills with every deposit.',
    progress: 62,
  },
  {
    share: '10%', t: 'Scheduled',
    one: 'Fires automatically on a schedule.',
    d: 'Set a recurring send from any hold bucket, daily, weekly or monthly. Sign once.',
  },
]

/* ── Nav-only icon toggle (does not affect the app dashboard toggle) ── */
function NavThemeToggle() {
  const [isDark, setIsDark] = useState(false)
  useEffect(() => { setIsDark(document.documentElement.classList.contains('dark')) }, [])
  function setTheme(dark: boolean) {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('split-theme', dark ? 'dark' : 'light')
    setIsDark(dark)
  }
  const pill = (active: boolean): React.CSSProperties => ({
    width: 28, height: 28, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: active ? 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)' : 'transparent',
    color: active ? '#fff' : 'var(--text-2)',
    boxShadow: active ? '0 2px 6px rgba(29,158,117,0.28)' : 'none',
    border: 'none', cursor: 'pointer', transition: 'all 0.15s',
  })
  return (
    <div role="group" aria-label="Color theme" style={{ display:'flex', alignItems:'center', gap:2, padding:3, borderRadius:999, background:'var(--bg-3)' }}>
      <button type="button" aria-label="Light mode" aria-pressed={!isDark} onClick={() => setTheme(false)} style={pill(!isDark)}><Sun size={13} /></button>
      <button type="button" aria-label="Dark mode"  aria-pressed={isDark}  onClick={() => setTheme(true)}  style={pill(isDark)}><Moon size={13} /></button>
    </div>
  )
}

/* ── Main component ──────────────────────────────────────────────── */
export default function SplitHomePage() {
  const [navScrolled,   setNavScrolled]   = useState(false)
  const [menuOpen,      setMenuOpen]      = useState(false)
  const [openFaq,       setOpenFaq]       = useState<number | null>(null)
  const [activeSection, setActiveSection] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const pinRef   = useRef<HTMLDivElement>(null)

  /* Scroll-driven logo split.
     Every frame recomputes the whole timeline from the current scroll offset rather
     than firing one-shot transitions, so reversing direction mid-way simply plays it
     backwards. Transforms are written straight to the elements — never through React
     state — so scrolling never triggers a re-render, and only compositor-friendly
     properties (transform / opacity / filter) are touched. */
  useEffect(() => {
    const stage = stageRef.current
    const pin   = pinRef.current
    if (!stage || !pin) return

    const copy   = pin.querySelector<HTMLElement>('.sp-hero-inner')
    /* Optional on purpose: the flow field is decorative and is absent under reduced
       motion, so a missing canvas must not abort the split timeline. */
    const field  = pin.querySelector<HTMLElement>('.sp-flow-field')
    const mark   = pin.querySelector<HTMLElement>('.sp-mark')
    const reveal = pin.querySelector<HTMLElement>('.sp-reveal')
    const inner  = pin.querySelector<HTMLElement>('.sp-reveal-inner')
    const grid   = pin.querySelector<HTMLElement>('.sp-pillars')
    const lead   = pin.querySelector<SVGSVGElement>('.sp-mark-lead')
    const trail  = pin.querySelector<SVGSVGElement>('.sp-mark-trail')
    if (!copy || !mark || !reveal || !inner || !grid || !lead || !trail) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

    /* Sine, not cubic. A cubic ease-in-out barely moves for its first third and then
       accelerates hard through the middle, which is what made the curtains read as
       creeping open and then snapping — and, in reverse, as slamming shut. Sine is
       gentle at both ends without the mid-range kick, so the motion stays even. */
    const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2
    /* The revealed block uses ease-out so it registers the moment the gap starts to
       open, rather than lurking near zero while the curtains are already parting. */
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
    /* Normalises a sub-range of the timeline to 0–1 so the beats can overlap. */
    const leg = (p: number, from: number, to: number) =>
      Math.min(1, Math.max(0, (p - from) / (to - from)))

    /* Distance from the pin's top to the mark's centre with no transform applied.
       Measured rather than read from offsetTop: the mark's wrapper carries the
       entrance animation, and a transformed ancestor becomes the offsetParent — so
       offsetTop reports a position relative to that wrapper, not the pin. */
    let restCentre = 0
    /* Where the halves come to rest: the centre of the card row, deliberately not the
       centre of the whole reveal block — the curtains frame the cards, and including
       the heading in that reckoning pushed them visibly high. */
    let cardsCentre = 0
    /* How much the halves grow between closed and fully open. Derived in measureRest
       rather than fixed, because the resting size gets capped on short windows and the
       open size has to hit 80% of a card regardless. HALF_OPEN_GROWTH is the uncapped
       ideal, used until the first measurement lands. */
    let openGrowth = HALF_OPEN_GROWTH
    function measureRest() {
      const held = mark!.style.transform
      mark!.style.transform = ''
      const pinTop = pin!.getBoundingClientRect().top
      const box = mark!.getBoundingClientRect()
      restCentre = box.top + box.height / 2 - pinTop
      /* scale() is centre-origin, so the row's midpoint is the same measured or not. */
      const cards = grid!.getBoundingClientRect()
      cardsCentre = cards.top + cards.height / 2 - pinTop

      /* Each open half should read as 80% of a card's height — 80% of the *drawn shape*,
         which is not the same as 80% of the <svg> box. Each half fills only part of the
         shared viewBox (the upper-left piece ~57% of its height, the lower-right ~66%),
         the remainder being transparent, so sizing the box to 80% leaves the visible
         green at barely half a card. getBBox() reports the path's own bounds in viewBox
         units, which is the only figure that tracks what is actually on screen.
         The taller of the two sets the scale, so neither half exceeds 80%. */
      /* getBBox throws on an element that is not being rendered. That should not happen
         here, but an exception would take the whole timeline down with it, so fall back
         to 0 — which skips the sizing and leaves the CSS default in place. */
      let shapeRatio = 0
      try {
        for (const half of [lead!, trail!]) {
          const path = half.querySelector('path')
          if (path) shapeRatio = Math.max(shapeRatio, path.getBBox().height / MARK_VIEWBOX.height)
        }
      } catch {
        shapeRatio = 0
      }

      if (shapeRatio > 0) {
        /* A single card's height, not the grid container's: on desktop the three cards
           sit in one row, so grid.offsetHeight happens to equal one card's height — but
           on narrow screens they stack into a column and the grid container is all three
           combined, which silently inflated the target to ~3x a card's real height.
           No fallback to grid.offsetHeight if the card is missing — that fallback IS the
           bug this just fixed. PILLARS always renders at least one card, so this should
           never be null; if it somehow is, skip the resize rather than resurrect it. */
        const referenceCard = grid!.querySelector<HTMLElement>('.sp-pillar')

        if (referenceCard) {
          /* offsetHeight, not getBoundingClientRect: it ignores the scale() transform
             .sp-reveal-inner carries, so it reads correctly even while the reveal is
             still shrunk down at its resting scale. */
          const targetOpenShape = referenceCard.offsetHeight * 0.8

          /* Resting size and open size are decoupled on purpose. At rest the mark sits
             below the hero copy inside a pin exactly one viewport tall, so on a short
             window a mark big enough to open at 80% would push the headline up under
             the nav. Cap the resting size to whatever actually fits... */
          const pinStyle = getComputedStyle(pin!)
          const spare = pin!.clientHeight
            - (parseFloat(pinStyle.paddingTop) || 0)
            - (parseFloat(pinStyle.rowGap) || 0)
            - copy!.offsetHeight
            - MARK_REST_BREATHING_ROOM
          const idealRestBox = targetOpenShape / shapeRatio / (1 + HALF_OPEN_GROWTH)
          const restBox = Math.max(MARK_MIN_REST_HEIGHT, Math.min(idealRestBox, spare))

          const ratio = MARK_VIEWBOX.width / MARK_VIEWBOX.height
          mark!.style.setProperty('--sp-mark-w', `${restBox * ratio}px`)

          /* ...then derive the open growth from whatever that cap allowed, so the drawn
             shape still lands on 80% of a card. A fixed growth factor would have shrunk
             the open state along with the capped resting size. */
          openGrowth = targetOpenShape / (restBox * shapeRatio) - 1
        }
      }

      mark!.style.transform = held
    }

    function paint(p: number) {
      /* Every beat completes inside the first ~58%; the rest of the stage is dwell,
         with nothing moving. That dwell is the point of the effect — it is what turns
         the parted halves into curtains framing a section you arrive at, rather than a
         pose the page strikes for an instant on its way past.
         Beats also overlap deliberately: a cubic ease is near-flat at its start, so
         the copy must still be on screen while the split creeps open, or there is a
         stretch of scroll where the copy has gone but the mark has visibly not moved. */
      const copyOut = easeInOutSine(leg(p, 0.02, 0.18))
      /* The mark travels up into place before it parts. Without this the halves are
         still down at hero height while the block grows in at its final position, and
         the two read as unrelated events rather than one opening. */
      const lift    = easeInOutSine(leg(p, 0.00, 0.24))
      /* Spread across most of the timeline rather than finishing at the halfway mark.
         A short split leaves a long dead stretch on the way back up, so reversing felt
         like nothing-then-everything; running it longer keeps the close as gradual as
         the open, while still leaving roughly a third of the stage as dwell. */
      const split   = easeInOutSine(leg(p, 0.06, 0.62))
      /* Starts only once the gap is genuinely wide enough to hold the block at its
         smallest, then widens alongside the still-parting curtains. Starting earlier
         put the cards on top of halves that had barely separated, hiding them
         completely — there was no opening for anything to come through yet. */
      const grow    = easeOutCubic(leg(p, 0.27, 0.72))

      copy!.style.opacity = String(1 - copyOut)
      /* The hero background leaves in lockstep with the hero copy, so the second
         section is reached on a plain background. The field reads this same inline
         opacity to know when to stop drawing entirely. */
      if (field) field.style.opacity = String(1 - copyOut)
      copy!.style.transform = `translate3d(0,${-64 * copyOut}px,0)`
      /* Faded copy still occupies the pin, so it would sit invisibly over the pillars,
         swallowing clicks and holding a tab stop. Two thresholds, not one: stop taking
         pointer input while it is still faintly visible, but only hide it (which also
         drops it from the tab order) once it is genuinely at zero — hiding at the
         halfway point would pop it off screen mid-fade. */
      copy!.style.pointerEvents = copyOut > 0.7 ? 'none' : ''
      copy!.style.visibility = copyOut > 0.98 ? 'hidden' : ''

      /* Raise the mark from its resting slot to the pin's optical centre as it opens,
         so the halves frame the revealed content instead of sitting below it. */
      mark!.style.transform = `translate3d(0,${(cardsCentre - restCentre) * lift}px,0)`

      /* Halves settle into curtain positions flanking the content, tucked slightly
         behind the outer cards so the frame reads as layered depth rather than three
         objects in a row. The diagonal offset between them closes at the same rate,
         so they sit level once open. Narrow screens push them further out, since
         there is no room to sit beside full-width cards. */
      const spread = window.innerWidth < PILLAR_STACK_BP ? CURTAIN_REACH.narrow : CURTAIN_REACH.wide
      const reach = window.innerWidth * spread * split
      const level = mark!.offsetHeight * 0.19 * split
      const halfScale = 1 + openGrowth * split
      lead!.style.transform  = `translate3d(${-reach}px,${level}px,0) scale(${halfScale})`
      trail!.style.transform = `translate3d(${reach}px,${-level}px,0) scale(${halfScale})`

      const glow = split < 0.02
        ? 'none'
        : `drop-shadow(0 0 ${30 * split}px rgba(95,244,157,${0.5 * split}))`
      lead!.style.filter = glow
      trail!.style.filter = glow

      /* Grows from nearly nothing to full size and is visible almost the whole way:
         the content is meant to be watched expanding out of the opening, so opacity
         only takes the edge off the very first instant and is never the reveal itself.
         Solid by a sixth of the way — long before the block is wide enough to reach
         the curtains, so the green is never seen through the cards. */
      inner!.style.opacity = String(Math.min(1, grow * 6))
      inner!.style.transform = `scale(${0.18 + 0.82 * grow})`

      /* The pillar buttons must not be tabbable while the block is still hidden. */
      reveal!.style.visibility = grow < 0.004 ? 'hidden' : ''
      reveal!.classList.toggle('is-live', grow > 0.6)
    }

    let frame = 0
    function onScroll() {
      /* Cancel-and-reschedule rather than an early return on a pending frame: if a
         frame is requested while the tab is backgrounded it may never run, and a
         first-wins guard would then latch permanently and freeze the timeline. */
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        const travel = stage!.offsetHeight - window.innerHeight
        const p = travel <= 0
          ? 0
          : Math.min(1, Math.max(0, -stage!.getBoundingClientRect().top / travel))
        paint(p)
      })
    }

    /* Reduced motion: drop every inline transform so the un-pinned CSS layout shows
       both states plainly, rather than freezing the page mid-animation. */
    function clearInline() {
      /* `field` is filtered out when absent — it is the one optional element here. */
      const targets = [copy, field, mark, reveal, inner, grid, lead, trail]
        .filter(Boolean) as Array<HTMLElement | SVGElement>
      for (const el of targets) {
        el.style.transform = ''
        el.style.opacity = ''
        el.style.filter = ''
        /* visibility and pointer-events are set by paint() too — leaving them behind
           would strand the copy hidden after a switch to reduced motion. */
        el.style.visibility = ''
        el.style.pointerEvents = ''
      }
      reveal!.classList.add('is-live')
    }

    /* Layout only changes on resize, so the rest position is re-measured there rather
       than per frame — paint() itself reads no geometry that forces a reflow. */
    function onResize() {
      measureRest()
      onScroll()
    }

    function sync() {
      if (reduced.matches) {
        window.removeEventListener('scroll', onScroll)
        window.removeEventListener('resize', onResize)
        clearInline()
        return
      }
      window.addEventListener('scroll', onScroll, { passive: true })
      window.addEventListener('resize', onResize)
      measureRest()
      onScroll()
    }

    sync()
    reduced.addEventListener('change', sync)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      reduced.removeEventListener('change', sync)
    }
  }, [])

  /* nav scroll glass */
  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 10)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  /* Nav scroll-spy — marks whichever section is crossing the middle of the viewport.
     Sections not yet on the page are skipped, so this stays correct while the
     remaining sections are still being built out. */
  useEffect(() => {
    const sections = NAV_LINKS
      .map((l) => document.getElementById(l.id))
      .filter((el): el is HTMLElement => el !== null)
    if (!sections.length) return

    const obs = new IntersectionObserver(
      () => {
        /* Resolve from geometry on every boundary crossing instead of retaining the
           last intersecting id. This clears the underline while the hero, CTA or
           footer occupies the nav band. */
        const navBandY = window.innerHeight * 0.475
        const current = sections.find((section) => {
          const rect = section.getBoundingClientRect()
          return rect.top <= navBandY && rect.bottom >= navBandY
        })
        setActiveSection(current?.id ?? null)
      },
      /* thin band across the vertical centre: only one section qualifies at a time */
      { rootMargin: '-45% 0px -50% 0px', threshold: 0 },
    )
    sections.forEach((s) => obs.observe(s))
    return () => obs.disconnect()
  }, [])

  /* general scroll-reveal */
  useEffect(() => {
    const els = document.querySelectorAll<Element>('[data-reveal], [data-cta-animate]')
    if (!els.length) return
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target) } })
      },
      { threshold: 0.1 },
    )
    els.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [])

  /* Mobile menu: lock background scroll + close on Escape */
  useEffect(() => {
    if (!menuOpen) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setMenuOpen(false)
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      {/* overflow-x must be `clip`, not `hidden`: `hidden` turns this element into a
          scroll container, which silently breaks `position:sticky` for every
          descendant — including the split stage's pin. `clip` crops identically
          without creating a scrollport. */}
      <div style={{ background: 'var(--bg)', color: 'var(--text)', fontFamily: "var(--font-inter,'Inter',sans-serif)", overflowX: 'clip' }}>

        {/* ── Nav ──────────────────────────────────────────── */}
        <nav className={`sp-nav${navScrolled ? ' scrolled' : ''}`}>
          <Link href="/" aria-label="Split — home" className="sp-nav-logo">
            <SplitLogo size={24} />
          </Link>
          <div className="sp-nav-center">
            {NAV_LINKS.map((l) => (
              <button
                key={l.id}
                className={`sp-nav-btn${activeSection === l.id ? ' is-active' : ''}`}
                onClick={() => scrollTo(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
          <div className="sp-nav-right">
            <span className="sp-nav-desktop"><NavThemeToggle /></span>
            <Link href="/app" className="sp-btn-cta">Launch Split</Link>
            <button
              className={`sp-ham${menuOpen ? ' open' : ''}`}
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              aria-controls="sp-mobile-menu"
            >
              <span className="sp-ham-box" aria-hidden="true"><span></span><span></span><span></span></span>
            </button>
          </div>
        </nav>
        <div
          id="sp-mobile-menu"
          className={`sp-mmenu${menuOpen ? ' open' : ''}`}
          aria-hidden={!menuOpen}
          onClick={(e) => { if (e.target === e.currentTarget) setMenuOpen(false) }}
        >
          <div className="sp-mmenu-panel">
            {NAV_LINKS.map((l) => (
              <button key={l.id} className="sp-mmenu-row" onClick={() => scrollTo(l.id)}>{l.label}</button>
            ))}
            <div className="sp-mmenu-div" />
            <div className="sp-mmenu-theme"><span>Theme</span><NavThemeToggle /></div>
          </div>
        </div>

        {/* ── Hero ─────────────────────────────────────────── */}
        <div className="sp-stage" ref={stageRef}>
          <div className="sp-stage-pin" ref={pinRef}>
            <FlowField className="sp-flow-field" />
            <div className="sp-hero-inner">
              <h1 className="sp-hero-h">
                <span className="sp-hero-h-loud">Split it. Pay them.</span>
                <span className="sp-hero-h-quiet">Keep it quiet.</span>
              </h1>
              <p className="sp-hero-sub">
                Split every deposit across your buckets. Pay your whole team in a single
                signature. Share a link that never turns into your public balance.
              </p>
              <div className="sp-hero-btns">
                <Link href="/app" className="sp-btn-cta">Launch Split</Link>
                <button className="sp-btn-hero-s" onClick={() => scrollTo('routing')}>See how it works</button>
              </div>
            </div>

            <div className="sp-mark-wrap">
              <SplitMark className="sp-mark" />
            </div>

            <div className="sp-reveal">
              <div className="sp-reveal-inner">
                <h2 className="sp-reveal-h">One payment, three endings.</h2>
                <div className="sp-pillars">
                  {PILLARS.map((p) => (
                    <button key={p.id} className="sp-pillar" onClick={() => scrollTo(p.id)}>
                      <span className="sp-pillar-ico">{p.icon}</span>
                      <span className="sp-pillar-t">{p.label}</span>
                      <span className="sp-pillar-d">{p.body}</span>
                      <span className="sp-pillar-go">Explore <ArrowRight size={14} /></span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Routing — bento grid. No eyebrow: the heading is the section's only
             label. "How it works" used to be its own numbered-step section above this
             one; folded into the title cell's caption instead, since it was entirely
             routing-specific content sitting right next to the section it explained. */}
        <section className="sp-sec sp-sec-alt" id="routing">
          <div className="sp-sec-inner">
            <div className="sp-routing-head">
              <h2 className="sp-routing-h" data-reveal>Four ways a bucket can behave.</h2>
              <p className="sp-routing-intro" data-reveal style={{ '--i': 1 } as React.CSSProperties}>
                Divide 100% across up to ten buckets. Give each bucket a percentage and
                a job, and Split applies your plan to every deposit.
              </p>
            </div>
            <div className="sp-rows">
              {BTYPES.map((b, i) => (
                <div key={b.t} className="sp-row" data-reveal style={{ '--i': i } as React.CSSProperties}>
                  <div className="sp-row-lead">
                    <span className="sp-row-share">{b.share}</span>
                    <h3 className="sp-row-t">{b.t}</h3>
                  </div>
                  <div>
                    <p className="sp-row-one">{b.one}</p>
                    {b.progress != null && (
                      <>
                        <div className="sp-row-bar">
                          <div className="sp-row-fill" style={{ width: `${b.progress}%` }} />
                        </div>
                        <div className="sp-row-cap">{b.progress}% of target</div>
                      </>
                    )}
                  </div>
                  <p className="sp-row-d">{b.d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Payroll ──────────────────────────────────────── */}
        <section className="sp-sec" id="payroll">
          <div className="sp-sec-inner">
            <h2 className="sp-pay-h" data-reveal>Pay your whole team in one transaction.</h2>
            <div className="sp-pay-grid">
              <div className="sp-pay-left">
                <p className="sp-pay-intro" data-reveal>
                  Add every recipient once, wallet address or Split handle, fixed amount
                  or percentage. Sign once and every recipient is paid in the same
                  transaction, same block.
                </p>
                <ul className="sp-pay-facts">
                  {PAYROLL_FACTS.map((f, i) => (
                    <li key={f} className="sp-pay-fact" data-reveal style={{ '--i': i } as React.CSSProperties}>
                      {f}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="sp-pay-card" data-reveal style={{ '--i': 1 } as React.CSSProperties}>
                <div className="sp-pay-card-top">
                  <span className="sp-pay-card-t">Batch disbursement</span>
                  <span className="sp-pay-card-l">4 RECIPIENTS</span>
                </div>
                {PAYROLL_BATCH.map((r) => (
                  <div key={r.to} className="sp-pay-line">
                    <span className="sp-pay-to">{r.to}</span>
                    <span className="sp-pay-kind">{r.kind}</span>
                    <span className="sp-pay-amt">{r.amount}<span className="sp-pay-tick"> ✓</span></span>
                  </div>
                ))}
                <div className="sp-pay-foot">ONE SIGNATURE · SAME BLOCK · 4,000.00 USDC</div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Privacy ──────────────────────────────────────── */}
        <section className="sp-sec sp-sec-alt" id="privacy">
          <div className="sp-sec-inner">
            <h2 className="sp-priv-h" data-reveal>They see a payment. They don&rsquo;t see you.</h2>
            <p className="sp-priv-intro" data-reveal style={{ '--i': 1 } as React.CSSProperties}>
              The sender and the amount stay public, like any transfer. What stays
              private is which address is yours.
            </p>

            {/* Illustrative, not a real record: the address halves and the round figure
                are invented, and are kept obviously so on a page making privacy claims. */}
            <div className="sp-priv-proof" data-reveal>
              <p className="sp-priv-proof-cap">what the explorer shows</p>
              {/* A description list, not divs: these are name/value pairs, and a dl
                  gives screen readers the association between key and value. */}
              <dl className="sp-priv-ledger">
                <div className="sp-priv-field">
                  <dt className="sp-priv-key">from</dt>
                  <dd className="sp-priv-val">0x4A2b…e31f</dd>
                </div>
                <div className="sp-priv-field">
                  <dt className="sp-priv-key">amount</dt>
                  <dd className="sp-priv-val">1,200.00 USDC</dd>
                </div>
                <div className="sp-priv-field is-last">
                  <dt className="sp-priv-key">to</dt>
                  <dd className="sp-priv-val is-subject">0x7c1a…9d04</dd>
                </div>
              </dl>
              <div className="sp-priv-cut">
                <span className="sp-priv-cut-line" aria-hidden="true" />
                <p className="sp-priv-cut-note">Nothing on-chain ties these together.</p>
                <span className="sp-priv-handle">split.app/pay/taiwo</span>
              </div>
            </div>

            <div className="sp-priv-rows">
              {PRIVACY_FEATURES.map((f, i) => (
                <div key={f.t} className="sp-priv-row" data-reveal style={{ '--i': i } as React.CSSProperties}>
                  <h3 className="sp-priv-t">{f.t}</h3>
                  <p className="sp-priv-d">{f.d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────── */}
        <section className="sp-sec" id="faq">
          <div className="sp-sec-inner">
            <h2 className="sp-faq-h" data-reveal>Common questions</h2>
            <p className="sp-faq-sub" data-reveal style={{ '--i': 1 } as React.CSSProperties}>
              Everything worth knowing before you connect a wallet.
            </p>
            <div className="sp-faq-wrap" data-reveal>
              {FAQS.map((item, i) => {
                /* One open index, so opening any answer closes whichever was open.
                   Storing a single value rather than a set is what enforces that. */
                const isOpen = openFaq === i
                return (
                  <div
                    key={item.q}
                    className={`sp-faq-item${isOpen ? ' is-open' : ''}`}
                    style={{ '--i': i } as React.CSSProperties}
                  >
                    <button
                      className="sp-faq-q"
                      id={`sp-faq-q-${i}`}
                      aria-expanded={isOpen}
                      aria-controls={`sp-faq-a-${i}`}
                      onClick={() => setOpenFaq((prev) => (prev === i ? null : i))}
                    >
                      <span>{item.q}</span>
                      <span className="sp-faq-icon" aria-hidden="true" />
                    </button>
                    <div
                      className="sp-faq-a"
                      id={`sp-faq-a-${i}`}
                      role="region"
                      aria-labelledby={`sp-faq-q-${i}`}
                    >
                      <div className="sp-faq-a-inner"><p>{item.a}</p></div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {/* ── Closing CTA ───────────────────────────────────── */}
        <section className="sp-cta-sec">
          <div className="sp-cta-box">
            <div className="sp-cta-left">
              <h2 className="sp-cta-h sp-cta-copy">
                <span className="sp-cta-line">
                  <span className="sp-cta-word" style={{ '--d': '0ms' } as React.CSSProperties}>Route</span>
                  <span className="sp-cta-word" style={{ '--d': '80ms' } as React.CSSProperties}>your</span>
                  <span className="sp-cta-word" style={{ '--d': '160ms' } as React.CSSProperties}>income.</span>
                </span>
                <span className="sp-cta-line">
                  <span className="sp-cta-word" style={{ '--d': '330ms' } as React.CSSProperties}>Pay</span>
                  <span className="sp-cta-word" style={{ '--d': '410ms' } as React.CSSProperties}>everyone.</span>
                </span>
                <span className="sp-cta-line">
                  <span className="sp-cta-word" style={{ '--d': '580ms' } as React.CSSProperties}>Keep</span>
                  <span className="sp-cta-word" style={{ '--d': '660ms' } as React.CSSProperties}>it</span>
                  <span className="sp-cta-word" style={{ '--d': '740ms' } as React.CSSProperties}>private.</span>
                </span>
              </h2>
              <p className="sp-cta-statement">
                Set the rules once. Split handles every payment that follows.
              </p>
              <div className="sp-cta-actions">
                <Link href="/app" className="sp-btn-cta">Launch Split</Link>
              </div>
            </div>

            <div className="sp-cta-flow" data-cta-animate>
              <div className="sp-cta-source">
                <div className="sp-cta-source-k">PAYMENT RECEIVED</div>
                <div className="sp-cta-source-v"><strong>1,200.00</strong><span>USDC</span></div>
              </div>

              <div className="sp-cta-input" aria-hidden="true">
                <span className="sp-cta-payment-token" />
              </div>

              <div className="sp-cta-core">
                <SplitMark className="sp-cta-mark" />
                <span className="sp-cta-core-token" aria-hidden="true" />
                <span className="sp-cta-blade" aria-hidden="true" />
              </div>

              <div className="sp-cta-branches" aria-hidden="true">
                <span className="sp-cta-branch"><span className="sp-cta-branch-token" /></span>
                <span className="sp-cta-branch"><span className="sp-cta-branch-token" /></span>
                <span className="sp-cta-branch"><span className="sp-cta-branch-token" /></span>
              </div>

              <div className="sp-cta-outcomes">
                <div className="sp-cta-outcome">
                  <span className="sp-cta-outcome-ico"><GitBranch size={19} /></span>
                  <span><strong>Route</strong><span className="sp-cta-outcome-d">Sort every deposit</span></span>
                </div>
                <div className="sp-cta-outcome">
                  <span className="sp-cta-outcome-ico"><Users size={19} /></span>
                  <span><strong>Payroll</strong><span className="sp-cta-outcome-d">Pay the whole team</span></span>
                </div>
                <div className="sp-cta-outcome">
                  <span className="sp-cta-outcome-ico"><EyeOff size={19} /></span>
                  <span><strong>Private</strong><span className="sp-cta-outcome-d">Keep your address unlinked</span></span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Footer ───────────────────────────────────────── */}
        <footer className="sp-footer">
          <div className="sp-footer-inner">
            {/* Brand column */}
            <div>
              <div className="sp-f-logo"><SplitLogo size={104} /></div>
              <div className="sp-f-tag">Your money sorts itself.</div>
            </div>

            {/* //LEARN */}
            <div className="sp-f-col">
              <p className="sp-f-col-head">//LEARN</p>
              <div className="sp-f-links">
                {NAV_LINKS.map((l) => (
                  <button key={l.id} className="sp-nav-btn" onClick={() => scrollTo(l.id)}>{l.label}</button>
                ))}
              </div>
            </div>

            {/* //NETWORK */}
            <div className="sp-f-col">
              <p className="sp-f-col-head">//NETWORK</p>
              <div className="sp-f-network">
                <p>Built on Arc Testnet</p>
                <p>Powered by USDC</p>
                <a href="https://arc.network" target="_blank" rel="noopener noreferrer">arc.network ↗</a>
              </div>
            </div>

            {/* //ACCESS */}
            <div className="sp-f-col">
              <p className="sp-f-col-head">//ACCESS</p>
              <div><Link href="/app" className="sp-btn-cta">Launch Split</Link></div>
            </div>
          </div>

          <div className="sp-footer-bot">
            <span>© 2026 Split. All rights reserved.</span>
            <span>Arc Testnet only. Not financial advice.</span>
          </div>
        </footer>
      </div>
    </>
  )
}
