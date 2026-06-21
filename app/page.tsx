'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import {
  Layers, Link as LinkIcon, ArrowDownToLine, GitBranch,
  ArrowUpRight, Wallet, Target, CalendarClock, Sun, Moon, CheckCircle2,
} from 'lucide-react'
import { SplitLogo } from '@/components/brand/logo'
import { ThemeToggle } from '@/components/theme-toggle'

/* ── Page-scoped CSS (sp- prefix, injected once, never leaks) ───── */
const PAGE_CSS = `
/* Glass variables — explicit rgba avoids color-mix() compat issues */
:root {
  --sp-glass-bg:      rgba(255,255,255,0.55);
  --sp-glass-border:  rgba(0,0,0,0.08);
  --sp-glass-card-bg: rgba(244,242,238,0.60);
  --sp-grad-from:     #1c1c1c;
}
.dark {
  --sp-glass-bg:      rgba(21,21,28,0.50);
  --sp-glass-border:  rgba(255,255,255,0.10);
  --sp-glass-card-bg: rgba(11,11,15,0.55);
  --sp-grad-from:     var(--text);
}

@keyframes fadeSlideUp {
  from { opacity:0; transform:translateY(28px); }
  to   { opacity:1; transform:translateY(0); }
}
@keyframes fadeSlideRight {
  from { opacity:0; transform:translateX(28px); }
  to   { opacity:1; transform:translateX(0); }
}
@keyframes accentPulse {
  0%,100% { opacity:1; }
  50%      { opacity:0.72; }
}
@keyframes marquee {
  from { transform:translateX(0); }
  to   { transform:translateX(-50%); }
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
  padding:0 40px; height:56px;
  border-bottom:0.5px solid var(--border);
  background:var(--bg);
  position:sticky; top:0; z-index:50;
  transition:background 0.25s, backdrop-filter 0.25s;
}
.sp-nav.scrolled {
  background:color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
}
.sp-nav-logo {
  flex:1; font-size:18px; font-weight:700; letter-spacing:-0.03em;
  color:var(--text); display:flex; align-items:center; gap:8px; text-decoration:none;
}
.sp-nav-logo .dot { color:var(--accent); }
.sp-nav-center { display:flex; gap:28px; }
.sp-nav-btn {
  font-size:13px; font-weight:500; color:var(--text-2);
  background:none; border:none; cursor:pointer; transition:color 0.15s; padding:0;
  font-family:inherit;
}
.sp-nav-btn:hover { color:var(--accent); }
.sp-nav-right { flex:1; display:flex; align-items:center; justify-content:flex-end; gap:10px; }
.sp-nav-desktop { display:inline-flex; align-items:center; }
.sp-btn-ghost {
  background:none; border:0.5px solid var(--border);
  border-radius:8px; padding:6px 14px; font-size:13px; font-weight:500;
  color:var(--text); cursor:pointer; font-family:inherit;
  transition:border-color 0.15s, color 0.15s;
}
.sp-btn-ghost:hover { border-color:var(--accent); color:var(--accent); }
.sp-btn-cta {
  background:linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%);
  color:#fff; border:none; border-radius:8px;
  padding:7px 16px; font-size:13px; font-weight:600; cursor:pointer;
  text-decoration:none; display:inline-flex; align-items:center;
  white-space:nowrap; transition:opacity 0.15s, transform 0.15s;
}
.sp-btn-cta:hover { opacity:0.85; transform:translateY(-1px); }
.sp-ham {
  display:none; background:none; border:0.5px solid var(--border);
  border-radius:8px; width:44px; height:44px; cursor:pointer;
  color:var(--text); align-items:center; justify-content:center;
  transition:background 0.15s, border-color 0.15s;
}
.sp-ham:hover { background:var(--bg-3); }
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
  position:absolute; top:56px; left:0; right:0;
  max-height:calc(100dvh - 56px); overflow-y:auto;
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
.sp-mmenu-row:hover, .sp-mmenu-row:active { background:var(--bg-3); color:var(--accent); }
.sp-mmenu-row:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.sp-mmenu-div { height:0.5px; background:var(--border); margin:10px 4px; }
.sp-mmenu-theme {
  display:flex; align-items:center; justify-content:space-between;
  padding:4px 12px; font-size:14px; font-weight:400; color:var(--text-2); font-family:var(--font-inter,'Inter',sans-serif);
}

/* ── Hero ── */
.sp-hero {
  position:relative; overflow:hidden; background:var(--bg);
  min-height:580px; display:flex; align-items:stretch;
}
/* Phase 1: diagonal mesh background */
.sp-hero-mesh {
  position:absolute; inset:0; z-index:0; pointer-events:none;
  background-image:
    linear-gradient(rgba(29,158,117,0.055) 1px, transparent 1px),
    linear-gradient(90deg, rgba(29,158,117,0.055) 1px, transparent 1px);
  background-size:44px 44px;
  transform:rotate(-14deg) scale(1.6);
  transform-origin:center center;
}
/* Phase 2: blurred colour orbs */
.sp-orb-1 {
  position:absolute; width:300px; height:300px; border-radius:50%;
  background:radial-gradient(circle, rgba(29,158,117,0.18) 0%, transparent 70%);
  right:120px; top:60px; z-index:0; filter:blur(48px); pointer-events:none;
}
.sp-orb-2 {
  position:absolute; width:200px; height:200px; border-radius:50%;
  background:radial-gradient(circle, rgba(6,182,212,0.14) 0%, transparent 70%);
  right:240px; bottom:80px; z-index:0; filter:blur(36px); pointer-events:none;
}
.sp-hero-bg-coin {
  position:absolute; right:-30px; top:50%;
  transform:translateY(-50%); z-index:1; pointer-events:none;
}
.sp-hero-fade {
  position:absolute; inset:0; z-index:2; pointer-events:none;
  background:linear-gradient(to right, var(--bg) 28%, color-mix(in srgb, var(--bg) 70%, transparent) 52%, transparent 75%);
}
.sp-hero-grid {
  position:relative; z-index:3;
  display:grid; grid-template-columns:1fr 1fr; gap:48px;
  align-items:center; max-width:1160px; margin:0 auto; padding:80px 40px;
  min-width:0;
}
.sp-hero-grid > * { min-width:0; }
.sp-hero-h {
  font-size:clamp(2rem,4vw,3.4rem); font-weight:700;
  line-height:1.08; letter-spacing:-0.035em; color:var(--text);
  animation:fadeSlideUp 0.7s ease forwards;
}
/* Phase 2: gradient first line */
.sp-h-grad {
  display:block;
  margin-bottom:16px;
  background:linear-gradient(135deg, var(--sp-grad-from) 30%, var(--accent) 100%);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent;
  background-clip:text;
}
.sp-hero-h .g { color:var(--accent); animation:accentPulse 3s 1s ease infinite; }
.sp-hero-sub {
  font-size:15px; color:var(--text-2); margin-top:18px;
  line-height:1.7; max-width:420px;
  opacity:0; animation:fadeSlideUp 0.7s 0.12s ease forwards;
}
.sp-hero-btns {
  display:flex; gap:12px; flex-wrap:wrap; margin-top:28px;
  opacity:0; animation:fadeSlideUp 0.7s 0.24s ease forwards;
}
.sp-btn-hero-p {
  background:linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%);
  color:#fff; border:none; border-radius:10px;
  padding:13px 28px; font-size:15px; font-weight:600; cursor:pointer;
  text-decoration:none; display:inline-flex; align-items:center;
  white-space:nowrap; transition:opacity 0.15s, transform 0.15s; font-family:inherit;
}
.sp-btn-hero-p:hover { opacity:0.85; transform:translateY(-1px); }
.sp-btn-hero-s {
  background:transparent; color:var(--text);
  border:1px solid var(--border); border-radius:10px;
  padding:13px 28px; font-size:15px; font-weight:500; cursor:pointer;
  transition:border-color 0.15s, color 0.15s; font-family:inherit;
}
.sp-btn-hero-s:hover { border-color:var(--accent); color:var(--accent); }
.sp-hero-demo {
  background:var(--bg-2);
  border:0.5px solid var(--border);
  border-radius:16px; padding:20px;
  opacity:0; animation:fadeSlideRight 0.8s 0.3s ease forwards;
}
@supports (backdrop-filter:blur(1px)) {
  .sp-hero-demo {
    background:var(--sp-glass-bg);
    backdrop-filter:blur(18px);
    -webkit-backdrop-filter:blur(18px);
    border-color:var(--sp-glass-border);
  }
}
.sp-demo-label {
  font-size:11px; font-weight:600; letter-spacing:0.1em;
  text-transform:uppercase; color:var(--text-3); text-align:center; margin-bottom:14px;
}
.sp-demo-cards { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.sp-bc {
  background:var(--bg);
  border:0.5px solid var(--border);
  border-radius:12px; padding:16px;
}
@supports (backdrop-filter:blur(1px)) {
  .sp-bc {
    background:var(--sp-glass-card-bg);
    border-color:var(--sp-glass-border);
  }
}
.sp-trust-row { display:none; overflow:hidden; min-width:0; max-width:100%; -webkit-mask-image:linear-gradient(to right,transparent 0%,black 12%,black 88%,transparent 100%); mask-image:linear-gradient(to right,transparent 0%,black 12%,black 88%,transparent 100%); }
.sp-trust-track { display:flex; gap:40px; width:max-content; animation:marquee 11s linear infinite; }
.sp-bc-name { font-size:13px; font-weight:600; color:var(--text); }
.sp-badge {
  display:inline-block; font-size:11px; font-weight:500;
  border-radius:999px; padding:2px 10px; margin-top:7px;
}
.b-gray  { background:var(--bg-3); color:var(--text-2); }
.b-green { background:var(--accent-bg); color:var(--accent); }
.b-amber { background:rgba(180,83,9,0.10); color:var(--warning,#B45309); }
.b-teal  { background:rgba(29,158,117,0.12); color:var(--accent); }
.sp-bc-bal {
  font-size:20px; font-weight:700;
  font-family:var(--font-jetbrains-mono,monospace);
  color:var(--text); letter-spacing:-0.02em; margin-top:12px;
}
.sp-bc-goal-bg { height:5px; background:var(--bg-2); border-radius:999px; overflow:hidden; margin-top:8px; }
.sp-bc-goal-fill { height:100%; background:var(--accent); border-radius:999px; }
.sp-bc-goal-lbl { font-size:11px; color:var(--text-3); margin-top:4px; }
.sp-bc-meta { font-size:11px; color:var(--text-3); font-family:var(--font-jetbrains-mono,monospace); margin-top:12px; }
.sp-demo-footer {
  margin-top:14px; padding-top:12px; border-top:0.5px solid var(--border);
  display:flex; justify-content:space-between; align-items:center;
}
.sp-demo-footer-l { font-size:12px; color:var(--text-3); }
.sp-demo-footer-r { font-size:12px; font-weight:600; color:var(--accent); }

/* ── Stats (Phase 2: gradient background + accent values) ── */
.sp-stats {
  display:flex; align-items:center; justify-content:center;
  border-top:0.5px solid var(--border); border-bottom:0.5px solid var(--border);
  background:linear-gradient(135deg, var(--accent-bg) 0%, var(--bg-3) 60%, rgba(6,182,212,0.06) 100%);
}
.sp-stat { flex:1; max-width:220px; text-align:center; padding:22px 16px; }
.sp-stat-v {
  font-size:26px; font-weight:700;
  font-family:var(--font-jetbrains-mono,monospace);
  color:var(--accent); letter-spacing:-0.02em;
}
.sp-stat-l {
  font-size:12px; font-weight:500; text-transform:uppercase;
  letter-spacing:0.06em; color:var(--text-2); margin-top:4px;
}
.sp-stat-div { width:1px; height:36px; background:var(--border); }

/* ── Sections ── */
.sp-sec { padding:80px 40px; }
.sp-sec-alt { background:var(--bg-2); }
.sp-sec-inner { max-width:1080px; margin:0 auto; }
.sp-sec-tag {
  font-size:11px; font-weight:600; text-transform:uppercase;
  letter-spacing:0.12em; color:var(--accent); text-align:center; margin-bottom:10px;
}
.sp-sec-h {
  font-size:clamp(1.6rem,3vw,2.3rem); font-weight:700; color:var(--text);
  text-align:center; letter-spacing:-0.025em; margin-bottom:8px;
}
.sp-sec-sub {
  font-size:15px; color:var(--text-2); text-align:center;
  max-width:480px; margin:0 auto 48px; line-height:1.6;
}

/* ── Phase 4: Timeline (replaces .sp-steps grid) ── */
.sp-timeline { display:flex; flex-direction:column; max-width:660px; margin:0 auto; }
.sp-tl-item {
  display:grid; grid-template-columns:52px 2px 1fr;
  gap:0 20px; align-items:stretch;
}
.sp-tl-num {
  grid-column:1;
  width:48px; height:48px; border-radius:50%; flex-shrink:0; margin-top:6px;
  background:var(--bg-3); border:2px solid var(--border);
  color:var(--text-2); font-weight:700; font-size:13px;
  display:flex; align-items:center; justify-content:center;
  font-family:var(--font-jetbrains-mono,monospace);
  transition:background 0.45s, border-color 0.45s, color 0.45s;
}
.sp-tl-item.revealed .sp-tl-num {
  background:var(--accent); border-color:var(--accent); color:#fff;
}
.sp-tl-track {
  grid-column:2;
  width:2px; background:var(--border); position:relative;
  margin:54px auto 0;
}
.sp-tl-track::after {
  content:''; position:absolute; top:0; left:0; width:100%;
  background:var(--accent); height:0%;
  transition:height 0.55s ease 0.3s;
}
.sp-tl-item.revealed .sp-tl-track::after { height:100%; }
.sp-tl-card {
  grid-column:3;
  background:var(--bg-2); border:0.5px solid var(--border);
  border-radius:14px; padding:24px 28px; margin-bottom:20px;
  opacity:0; transform:translateX(22px);
  transition:opacity 0.45s ease, transform 0.45s ease;
}
.sp-tl-item.revealed .sp-tl-card { opacity:1; transform:translateX(0); }
.sp-tl-ico { color:var(--accent); margin-bottom:10px; }
.sp-tl-t { font-size:16px; font-weight:600; color:var(--text); margin-bottom:6px; }
.sp-tl-d { font-size:14px; color:var(--text-2); line-height:1.65; }
.sp-tl-item:last-child .sp-tl-track { display:none; }

/* ── Phase 3: Bucket cards — cursor spotlight ── */
.sp-btypes { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.sp-bt {
  border-radius:12px; padding:24px;
  transition:transform 0.2s, box-shadow 0.2s;
  position:relative; overflow:hidden;
}
.sp-bt::before {
  content:''; position:absolute; inset:0; z-index:0; pointer-events:none;
  background:radial-gradient(
    380px circle at var(--mx,50%) var(--my,50%),
    rgba(29,158,117,0.13) 0%, transparent 65%
  );
  opacity:0; transition:opacity 0.25s;
}
.sp-bt:hover::before { opacity:1; }
.sp-bt:hover { transform:translateY(-3px); box-shadow:0 8px 24px rgba(0,0,0,0.08); }
.sp-bt > * { position:relative; z-index:1; }
/* base border lives in CSS so inline style only overrides the top */
.sp-bt { border:0.5px solid var(--border); }
.sp-bt-top { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:14px; }
.sp-bt-ico { color:var(--accent); flex-shrink:0; }
.sp-bt-t { font-size:15px; font-weight:600; color:var(--text); margin-bottom:6px; }
.sp-bt-d { font-size:13px; color:var(--text-2); line-height:1.6; }
.sp-pill {
  display:inline-flex; margin-top:14px; background:var(--bg-3);
  border-radius:999px; padding:4px 12px; font-size:11px;
  font-family:var(--font-jetbrains-mono,monospace); color:var(--text-2);
}

/* ── FAQ ── */
.sp-faq-wrap { max-width:640px; margin:0 auto; }
.sp-faq-item { border-bottom:0.5px solid var(--border); }
.sp-faq-q {
  display:flex; justify-content:space-between; align-items:center;
  cursor:pointer; padding:18px 0; font-size:15px; font-weight:500;
  color:var(--text); user-select:none; gap:16px;
  background:none; border:none; width:100%; text-align:left;
  font-family:inherit; transition:color 0.15s;
}
.sp-faq-q:hover { color:var(--accent); }
.sp-faq-icon {
  font-size:20px; color:var(--text-2); flex-shrink:0;
  transition:transform 0.3s; line-height:1;
}
.sp-faq-icon.open { transform:rotate(45deg); }
.sp-faq-a {
  font-size:14px; color:var(--text-2); line-height:1.7;
  overflow:hidden; max-height:0;
  transition:max-height 0.3s ease, padding-bottom 0.3s;
}
.sp-faq-a.open { max-height:260px; padding-bottom:16px; }

/* ── CTA (Phase 2: gradient) ── */
.sp-cta-sec { padding:96px 40px; text-align:center; background:var(--bg); }
.sp-cta-box {
  max-width:520px; margin:0 auto;
  background:linear-gradient(135deg, #1D9E75 0%, #0ea5e9 100%);
  border:none; border-radius:20px; padding:48px 40px;
}
.sp-cta-h {
  font-size:clamp(1.8rem,3.5vw,2.5rem); font-weight:700; color:#fff;
  letter-spacing:-0.025em; line-height:1.1;
}
.sp-cta-p { font-size:15px; color:rgba(255,255,255,0.85); margin:14px 0 28px; line-height:1.6; }
.sp-cta-trust { font-size:12px; color:rgba(255,255,255,0.7); margin-top:20px; }
.sp-btn-full {
  background:#fff; color:#1D9E75; border:none; border-radius:10px;
  padding:13px 28px; font-size:15px; font-weight:700; cursor:pointer;
  text-decoration:none; display:flex; align-items:center; justify-content:center;
  transition:opacity 0.15s, transform 0.15s; font-family:inherit; width:100%;
}
.sp-btn-full:hover { opacity:0.92; transform:translateY(-1px); }

/* ── Footer ── */
.sp-footer { background:var(--bg-3); border-top:0.5px solid var(--border); padding:52px 40px 36px; }
.sp-footer-inner {
  max-width:1080px; margin:0 auto;
  display:grid; grid-template-columns:2fr 1fr 1fr 1fr; gap:40px;
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
.sp-f-links .sp-nav-btn:hover { color:var(--text); }
.sp-f-network { display:flex; flex-direction:column; gap:10px; }
.sp-f-network p,.sp-f-network a { font-size:13px; color:var(--text-2); text-decoration:none; }
.sp-f-network a { color:var(--accent); }
.sp-f-network a:hover { opacity:0.8; }
.sp-f-open-btn {
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%); color:#fff; font-size:15px; font-weight:700;
  padding:14px 20px; border-radius:10px; text-decoration:none;
  border:none; cursor:pointer; width:100%; transition:opacity 0.15s;
}
.sp-f-open-btn:hover { opacity:0.88; }
.sp-footer-bot {
  max-width:1080px; margin:36px auto 0;
  padding-top:20px; border-top:0.5px solid var(--border);
  display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:12px;
}
.sp-footer-bot-left { display:flex; flex-direction:column; gap:5px; }
.sp-footer-bot-left span { font-size:12px; color:var(--text-3); }
.sp-footer-bot-right { display:flex; align-items:center; gap:6px; }
.sp-footer-bot-right a { font-size:12px; color:var(--text-3); text-decoration:none; padding:0 4px; transition:color 0.15s; }
.sp-footer-bot-right a:hover { color:var(--text-2); }
.sp-footer-bot-sep { font-size:12px; color:var(--border); user-select:none; }

/* ── Focus-visible (keyboard navigation) ── */
.sp-nav-btn:focus-visible,
.sp-btn-ghost:focus-visible,
.sp-ham:focus-visible,
.sp-btn-hero-s:focus-visible,
.sp-faq-q:focus-visible {
  outline:2px solid var(--accent); outline-offset:3px;
}
.sp-btn-cta:focus-visible,
.sp-btn-hero-p:focus-visible,
.sp-btn-full:focus-visible {
  outline:2px solid #fff; outline-offset:3px;
}

/* ── Responsive ── */
@media(max-width:900px){
  .sp-footer-inner { grid-template-columns:1fr 1fr; }
  .sp-footer-inner > div:first-child { grid-column:1/-1; }
  .sp-hero-grid { grid-template-columns:1fr; gap:40px; padding:64px 32px; }
  .sp-hero-bg-coin { right:-120px; opacity:0.22; }
  .sp-hero-fade { background:linear-gradient(to right, var(--bg) 60%, transparent 100%); }
}
@media(max-width:640px){
  .sp-nav-center { display:none; }
  .sp-nav-desktop { display:none; }
  .sp-ham { display:flex; }
  .sp-btypes { grid-template-columns:1fr; }
  .sp-stats { flex-direction:column; }
  .sp-stat-div { width:48px; height:1px; }
  .sp-footer-inner { grid-template-columns:1fr; }
  .sp-footer-bot { flex-direction:column; align-items:flex-start; }
  .sp-f-tag { max-width:none; }
  .sp-cta-box { padding:32px 24px; }
  .sp-demo-cards { grid-template-columns:1fr; }
  .sp-sec { padding:64px 20px; }
  .sp-nav { padding:0 20px; }
  .sp-hero-grid { padding:56px 20px; }
  .sp-hero-bg-coin { right:-160px; }
  .sp-hero-h { font-size:38px; line-height:1.05; }
  .sp-hero-btns { flex-direction:column; gap:12px; margin-top:24px; }
  .sp-btn-hero-p { width:100%; height:52px; border-radius:14px; justify-content:center; font-size:16px; }
  .sp-btn-hero-s { width:100%; height:52px; border-radius:14px; display:flex; justify-content:center; align-items:center; }
  .sp-trust-row { display:flex; margin-top:16px; }
  .sp-trust-row span { display:inline-flex; align-items:center; gap:5px; font-size:12px; font-weight:500; color:var(--accent); white-space:nowrap; }
  .sp-hero-demo { margin-top:28px; background:var(--bg-2); border:0.5px solid var(--border); box-shadow:0 2px 20px rgba(0,0,0,0.07); }
  .sp-bc { background:var(--bg-3); border:0.5px solid var(--border); }
  .dark .sp-hero-demo { background:rgba(21,21,28,0.70); border-color:rgba(255,255,255,0.10); box-shadow:none; backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px); }
  .dark .sp-bc { background:rgba(11,11,15,0.65); border-color:rgba(255,255,255,0.08); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px); }
}
@media(max-width:520px){
  .sp-tl-item { grid-template-columns:40px 0 1fr; gap:0 12px; }
  .sp-tl-track { display:none; }
}
`

/* ── Static data ─────────────────────────────────────────────────── */
const FAQS = [
  { q: 'What is Split?', a: 'Split is a programmable USDC payment hub. You define rules for how incoming USDC gets distributed, and every deposit routes to your buckets automatically in one transaction.' },
  { q: 'Is Split custodial?', a: 'No. Your USDC is held in an open smart contract, not by Split or any company. The contract can only ever send funds to the wallet destinations you defined. There is no admin key.' },
  { q: 'Does the person paying me need to use Split?', a: "No. They open your pay link, connect any EVM wallet with USDC on Arc, and click Pay. They never touch Split's interface." },
  { q: 'Can I change my buckets later?', a: 'Yes, any time from the Buckets tab. Edit percentages, rename, add new ones, or delete existing ones. Deleting a bucket automatically refunds any held balance to your wallet.' },
  { q: 'What is the maximum number of buckets?', a: '10 active buckets per wallet. Buckets must total exactly 100% before you can receive payments.' },
  { q: 'What are scheduled sends?', a: 'A recurring outbound transfer from any hold bucket, daily, weekly, or monthly. You sign the authorization once and the contract executes it automatically going forward.' },
]

const STEPS = [
  { n: '01', icon: <Layers size={24} />,         t: 'Create your buckets',  d: 'Name each bucket and set its percentage. Savings, rent, tax, business costs. Up to 10 buckets totalling 100%.' },
  { n: '02', icon: <LinkIcon size={24} />,        t: 'Share your pay link',  d: 'You get a unique URL at split.app/pay/you. Send it to clients, add it to invoices. No signup required to pay you.' },
  { n: '03', icon: <ArrowDownToLine size={24} />, t: 'Payment arrives',      d: 'USDC lands in the Split contract. Your rules fire immediately, in the same transaction, sub-second on Arc.' },
  { n: '04', icon: <GitBranch size={24} />,       t: 'Money routes itself',  d: 'Auto-send buckets push to wallets instantly. Hold buckets accumulate. Goals track progress. Nothing to do.' },
]

/* Phase 2 + 3: per-type accent color and card background tint */
const BTYPES = [
  {
    badge: 'b-green', bl: '↗ Auto-sends', accent: '#1D9E75',
    tint: 'color-mix(in srgb, var(--bg) 95%, #1D9E75)',
    t: 'Sends the moment USDC arrives',
    d: "Set a destination wallet. Every deposit pushes that bucket's share there immediately. No manual step, no delay, same transaction.",
    pill: '30% → 0x4A2b…e31f', icon: <ArrowUpRight size={22} />,
  },
  {
    badge: 'b-gray', bl: 'Holds', accent: '#6366f1',
    tint: 'color-mix(in srgb, var(--bg) 95%, #6366f1)',
    t: 'Accumulates until you are ready',
    d: 'Funds stay in the Split contract under your address. Withdraw any amount to any wallet at any time. Full control, no lock-in.',
    pill: '40% → holds in contract', icon: <Wallet size={22} />,
  },
  {
    badge: 'b-amber', bl: '◎ Goal', accent: '#f59e0b',
    tint: 'color-mix(in srgb, var(--bg) 95%, #f59e0b)',
    t: 'Tracks your savings target',
    d: 'Attach a target to any hold bucket. A progress bar fills with every deposit. Reach the goal and withdraw. Entirely on-chain.',
    pill: '20% → $320 of $1,000 saved', icon: <Target size={22} />,
  },
  {
    badge: 'b-teal', bl: '⏱ Scheduled', accent: '#06b6d4',
    tint: 'color-mix(in srgb, var(--bg) 95%, #06b6d4)',
    t: 'Fires automatically on a schedule',
    d: 'Set a recurring send from any hold bucket, daily, weekly, or monthly. Sign once. The contract handles execution without your signature again.',
    pill: '10% → sends $300 on the 1st', icon: <CalendarClock size={22} />,
  },
]

/* ── Phase 3: BucketCard with cursor-following spotlight ─────────── */
function BucketCard({ b, i }: { b: typeof BTYPES[0]; i: number }) {
  const ref = useRef<HTMLDivElement>(null)
  function onMove(e: React.MouseEvent) {
    const el = ref.current; if (!el) return
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${e.clientX - r.left}px`)
    el.style.setProperty('--my', `${e.clientY - r.top}px`)
  }
  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      className="sp-bt"
      data-reveal
      style={{
        '--i': i,
        borderTopWidth: '2.5px',
        borderTopColor: b.accent,
        background: b.tint,
      } as React.CSSProperties}
    >
      <div className="sp-bt-top">
        <div>
          <div className={`sp-badge ${b.badge}`} style={{ marginBottom: 10 }}>{b.bl}</div>
          <div className="sp-bt-t">{b.t}</div>
        </div>
        <div className="sp-bt-ico">{b.icon}</div>
      </div>
      <div className="sp-bt-d">{b.d}</div>
      <div className="sp-pill">{b.pill}</div>
    </div>
  )
}

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
  const [navScrolled, setNavScrolled] = useState(false)
  const [menuOpen,    setMenuOpen]    = useState(false)
  const [openFaq,     setOpenFaq]     = useState<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef   = useRef<number>(0)

  /* Phase 1: vertical coin canvas with float bob */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    if (!ctx) return

    const W = 520, H = 560
    const cx = W / 2, cy = H / 2
    const R = 190          // face radius
    const edgeW = 20       // right-edge strip half-width (3D thickness illusion)

    const faceLight = '#5BA3D9'
    const faceMid   = '#2774AE'
    const faceDark  = '#1A5276'
    const edgeLight = '#6CB4E8'
    const edgeDark  = '#0E3D60'

    let angle = 0

    function drawFrame() {
      ctx.clearRect(0, 0, W, H)

      const coinY       = Math.sin(Date.now() * 0.0009) * 14
      const shadowScale = 1 - Math.abs(coinY) * 0.005

      /* ground shadow */
      const sg = ctx.createRadialGradient(cx + 14, cy + R + 18, R * 0.08, cx + 14, cy + R + 18, R * 0.65)
      sg.addColorStop(0, 'rgba(0,0,0,0.18)')
      sg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = sg
      ctx.beginPath()
      ctx.ellipse(cx + 14, cy + R + 18, R * 0.65 * shadowScale, R * 0.15 * shadowScale, 0, 0, Math.PI * 2)
      ctx.fill()

      ctx.save()
      ctx.translate(0, -coinY)

      /* right-edge 3D strip */
      const edgeGrad = ctx.createLinearGradient(cx + R - edgeW, cy - R, cx + R + edgeW, cy + R)
      edgeGrad.addColorStop(0, edgeLight)
      edgeGrad.addColorStop(0.4, edgeDark)
      edgeGrad.addColorStop(1, edgeDark)
      ctx.fillStyle = edgeGrad
      ctx.beginPath()
      ctx.ellipse(cx + R, cy, edgeW, R, 0, 0, Math.PI * 2)
      ctx.fill()

      /* outer rim shadow on the circle edge (dark stroke) */
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI * 2)
      ctx.strokeStyle = edgeDark
      ctx.lineWidth = 4
      ctx.stroke()

      /* coin face — full circle with radial gradient */
      const faceGrad = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.04, cx, cy, R * 1.05)
      faceGrad.addColorStop(0, faceLight)
      faceGrad.addColorStop(0.5, faceMid)
      faceGrad.addColorStop(1, faceDark)
      ctx.fillStyle = faceGrad
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI * 2)
      ctx.fill()

      /* inner ring */
      const innerR = R * 0.82
      ctx.beginPath()
      ctx.arc(cx, cy, innerR, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 2.5
      ctx.stroke()

      /* rotating shimmer */
      const sx = cx + Math.cos(angle) * innerR * 0.65
      const sy = cy + Math.sin(angle) * innerR * 0.35
      const sh = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 0.6)
      sh.addColorStop(0, 'rgba(255,255,255,0.25)')
      sh.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = sh
      ctx.beginPath()
      ctx.arc(cx, cy, innerR - 1, 0, Math.PI * 2)
      ctx.fill()

      /* $ symbol */
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
      ctx.font = 'bold 110px Arial'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('$', cx, cy + 4)

      /* USDC label */
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.font = '600 24px Arial'
      ctx.fillText('USDC', cx, cy + 78)

      ctx.restore()

      angle += 0.008
      animRef.current = requestAnimationFrame(drawFrame)
    }

    animRef.current = requestAnimationFrame(drawFrame)
    return () => cancelAnimationFrame(animRef.current)
  }, [])

  /* nav scroll glass */
  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 10)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  /* general scroll-reveal */
  useEffect(() => {
    const els = document.querySelectorAll<Element>('[data-reveal]')
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

  /* Phase 4: sequential timeline reveal */
  useEffect(() => {
    const items = Array.from(document.querySelectorAll<HTMLElement>('.sp-tl-item'))
    if (!items.length) return
    let idx = 0
    let activeObs: IntersectionObserver | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    function revealNext() {
      if (idx >= items.length) return
      const item = items[idx]!
      activeObs = new IntersectionObserver(([e]) => {
        if (!e || !e.isIntersecting) return
        item.classList.add('revealed')
        activeObs?.disconnect()
        activeObs = null
        idx++
        timer = setTimeout(revealNext, 220)
      }, { threshold: 0.25 })
      activeObs.observe(item)
    }
    revealNext()
    return () => {
      activeObs?.disconnect()
      if (timer !== null) clearTimeout(timer)
    }
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
      <div style={{ background: 'var(--bg)', color: 'var(--text)', fontFamily: "var(--font-inter,'Inter',sans-serif)", overflowX: 'hidden' }}>

        {/* ── Nav ──────────────────────────────────────────── */}
        <nav className={`sp-nav${navScrolled ? ' scrolled' : ''}`}>
          <Link href="/" aria-label="Split — home" className="sp-nav-logo">
            <SplitLogo size={24} />
          </Link>
          <div className="sp-nav-center">
            <button className="sp-nav-btn" onClick={() => scrollTo('how-it-works')}>How it works</button>
            <button className="sp-nav-btn" onClick={() => scrollTo('buckets')}>Buckets</button>
            <button className="sp-nav-btn" onClick={() => scrollTo('faq')}>FAQ</button>
          </div>
          <div className="sp-nav-right">
            <span className="sp-nav-desktop"><NavThemeToggle /></span>
            <Link href="/app" className="sp-btn-cta">Open App</Link>
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
            <button className="sp-mmenu-row" onClick={() => scrollTo('how-it-works')}>How it works</button>
            <button className="sp-mmenu-row" onClick={() => scrollTo('buckets')}>Buckets</button>
            <button className="sp-mmenu-row" onClick={() => scrollTo('faq')}>FAQ</button>
            <div className="sp-mmenu-div" />
            <div className="sp-mmenu-theme"><span>Theme</span><NavThemeToggle /></div>
          </div>
        </div>

        {/* ── Hero ─────────────────────────────────────────── */}
        <section className="sp-hero">
          {/* Phase 1: mesh + orbs */}
          <div className="sp-hero-mesh" aria-hidden="true" />
          <div className="sp-orb-1" aria-hidden="true" />
          <div className="sp-orb-2" aria-hidden="true" />
          {/* Phase 1: vertical coin canvas */}
          <div className="sp-hero-bg-coin">
            <canvas ref={canvasRef} width={520} height={560} aria-hidden="true" />
          </div>
          <div className="sp-hero-fade" aria-hidden="true" />
          <div className="sp-hero-grid">
            <div>
              <h1 className="sp-hero-h">
                {/* Phase 2: gradient first line */}
                <span className="sp-h-grad">Get paid once.</span>
                <span className="g">Your money sorts itself.</span>
              </h1>
              <p className="sp-hero-sub">
                Define buckets for savings, expenses, and goals. Share your Split link.
                Every USDC payment splits the moment it arrives. No transfers. No spreadsheets.
              </p>
              <div className="sp-hero-btns">
                <Link href="/app" className="sp-btn-hero-p">Open App →</Link>
                <button className="sp-btn-hero-s" onClick={() => scrollTo('how-it-works')}>See how it works ↓</button>
              </div>
              <div className="sp-trust-row">
                <div className="sp-trust-track">
                  <span><CheckCircle2 size={14} />No spreadsheets</span>
                  <span><CheckCircle2 size={14} />No transfers</span>
                  <span><CheckCircle2 size={14} />Auto-splits deposits</span>
                  <span><CheckCircle2 size={14} />No spreadsheets</span>
                  <span><CheckCircle2 size={14} />No transfers</span>
                  <span><CheckCircle2 size={14} />Auto-splits deposits</span>
                </div>
              </div>
            </div>
            <div>
              <div className="sp-hero-demo">
                <div className="sp-demo-label">Live bucket preview</div>
                <div className="sp-demo-cards">
                  <div className="sp-bc">
                    <div className="sp-bc-name">Savings</div>
                    <div className="sp-badge b-gray">Holds</div>
                    <div className="sp-bc-bal">24.00 USDC</div>
                    <div className="sp-bc-goal-bg">
                      <div className="sp-bc-goal-fill" style={{ width: '24%' }} />
                    </div>
                    <div className="sp-bc-goal-lbl">$24 of $100 goal</div>
                  </div>
                  <div className="sp-bc">
                    <div className="sp-bc-name">Business</div>
                    <div className="sp-badge b-green">↗ Auto-sends</div>
                    <div className="sp-bc-bal">0.00 USDC</div>
                    <div className="sp-bc-meta">0x4A2b…e31f</div>
                  </div>
                </div>
                <div className="sp-demo-footer">
                  <span className="sp-demo-footer-l">Arc Testnet · USDC</span>
                  <span className="sp-demo-footer-r">2 of 10 buckets active</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Stats (Phase 2: gradient bg, accent values) ───── */}
        <div className="sp-stats" data-reveal>
          <div className="sp-stat">
            <div className="sp-stat-v">$0.00</div>
            <div className="sp-stat-l">Total deposited</div>
          </div>
          <div className="sp-stat-div" aria-hidden="true" />
          <div className="sp-stat">
            <div className="sp-stat-v">0</div>
            <div className="sp-stat-l">Payments split</div>
          </div>
          <div className="sp-stat-div" aria-hidden="true" />
          <div className="sp-stat">
            <div className="sp-stat-v">&lt;1s</div>
            <div className="sp-stat-l">Routing time</div>
          </div>
        </div>

        {/* ── How it works (Phase 4: vertical timeline) ─────── */}
        <section className="sp-sec" id="how-it-works">
          <div className="sp-sec-inner">
            <div className="sp-sec-tag" data-reveal>How it works</div>
            <h2 className="sp-sec-h" data-reveal>Set it up in two minutes</h2>
            <p className="sp-sec-sub" data-reveal>No contract knowledge needed. No manual transfers ever again.</p>
            <div className="sp-timeline">
              {STEPS.map((s) => (
                <div key={s.n} className="sp-tl-item">
                  <div className="sp-tl-num">{s.n}</div>
                  <div className="sp-tl-track" aria-hidden="true" />
                  <div className="sp-tl-card">
                    <div className="sp-tl-ico">{s.icon}</div>
                    <div className="sp-tl-t">{s.t}</div>
                    <div className="sp-tl-d">{s.d}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Bucket types (Phase 2 + 3) ───────────────────── */}
        <section className="sp-sec sp-sec-alt" id="buckets">
          <div className="sp-sec-inner">
            <div className="sp-sec-tag" data-reveal>Bucket types</div>
            <h2 className="sp-sec-h" data-reveal>Four ways to route your money</h2>
            <p className="sp-sec-sub" data-reveal>Mix and match. Every bucket serves a different purpose.</p>
            <div className="sp-btypes">
              {BTYPES.map((b, i) => <BucketCard key={i} b={b} i={i} />)}
            </div>
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────── */}
        <section className="sp-sec" id="faq">
          <div className="sp-sec-inner">
            <div className="sp-sec-tag" data-reveal>FAQ</div>
            <h2 className="sp-sec-h" data-reveal>Common questions</h2>
            <p className="sp-sec-sub" data-reveal>Everything you need before you connect a wallet.</p>
            <div className="sp-faq-wrap" data-reveal>
              {FAQS.map((item, i) => (
                <div key={i} className="sp-faq-item">
                  <button
                    className="sp-faq-q"
                    onClick={() => setOpenFaq((prev) => (prev === i ? null : i))}
                  >
                    <span>{item.q}</span>
                    <span className={`sp-faq-icon${openFaq === i ? ' open' : ''}`} aria-hidden="true">+</span>
                  </button>
                  <div className={`sp-faq-a${openFaq === i ? ' open' : ''}`}>{item.a}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── CTA (Phase 2: gradient) ───────────────────────── */}
        <section className="sp-cta-sec">
          <div className="sp-cta-box" data-reveal>
            <div className="sp-cta-h">Start routing<br />your money</div>
            <p className="sp-cta-p">Connect a wallet. Create your buckets. Share your pay link. Under two minutes.</p>
            <Link href="/app" className="sp-btn-full">Open App →</Link>
            <div className="sp-cta-trust">Non-custodial · No fees · Arc Testnet · Open source</div>
          </div>
        </section>

        {/* ── Footer ───────────────────────────────────────── */}
        <footer className="sp-footer">
          <div className="sp-footer-inner">
            {/* Brand column */}
            <div>
              <div className="sp-f-logo"><SplitLogo size={52} /></div>
              <div className="sp-f-tag">Your money sorts itself.</div>
            </div>

            {/* //LEARN */}
            <div className="sp-f-col">
              <p className="sp-f-col-head">//LEARN</p>
              <div className="sp-f-links">
                <button className="sp-nav-btn" onClick={() => scrollTo('how-it-works')}>How it works</button>
                <button className="sp-nav-btn" onClick={() => scrollTo('buckets')}>Buckets</button>
                <button className="sp-nav-btn" onClick={() => scrollTo('faq')}>FAQ</button>
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
              <Link href="/app" className="sp-f-open-btn">Open App</Link>
            </div>
          </div>

          <div className="sp-footer-bot">
            <div className="sp-footer-bot-left">
              <span>© 2026 Split. All rights reserved.</span>
              <span>Arc Testnet only. Not financial advice.</span>
            </div>
            <div className="sp-footer-bot-right">
              <a href="#">Terms</a>
              <span className="sp-footer-bot-sep">|</span>
              <a href="#">Privacy</a>
              <span className="sp-footer-bot-sep">|</span>
              <a href="#">Brand Kit</a>
            </div>
          </div>
        </footer>
      </div>
    </>
  )
}
