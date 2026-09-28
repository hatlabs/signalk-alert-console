/**
 * Shared theme CSS custom properties for light and dark mode.
 *
 * Import and spread into component styles:
 *   static styles = [themeStyles, css`...`]
 *
 * Priority colors (--priority-<name>-color, --priority-<name>-bg) are defined
 * here and referenced via priorityVars() in priority.ts; the theme provides
 * both priority and non-priority UI chrome variables.
 */

import { css } from 'lit'

export const themeStyles = css`
  :host {
    color-scheme: light dark;

    --bg-primary: #fff;
    --bg-secondary: #f5f5f5;
    --bg-hover: #f5f5f5;
    --text-primary: #222;
    --text-secondary: #444;
    --text-muted: #666;
    --text-dim: #888;
    --border-primary: #e0e0e0;
    --border-secondary: #ccc;

    --badge-state-bg: #e0e0e0;
    --badge-state-text: #333;
    --badge-group-bg: #f0f0f0;
    --badge-group-text: #666;
    --badge-stale-bg: #fff3cd;
    --badge-stale-text: #856404;
    --badge-silenced-bg: #e8eaf6;
    --badge-silenced-text: #3949ab;

    --btn-bg: #fff;
    --btn-border: #ccc;
    --btn-ack-border: #4caf50;
    --btn-ack-text: #2e7d32;
    --btn-silence-border: #1976d2;
    --btn-silence-text: #1565c0;
    --btn-dismiss-border: #9e9e9e;
    --btn-dismiss-text: #616161;
    --btn-silence-all-bg: #fff;
    --btn-silence-all-border: #1976d2;
    --btn-silence-all-text: #1565c0;
    --btn-silence-all-hover: #e3f2fd;
    --btn-sim-border: #e65100;
    --btn-sim-text: #e65100;
    --btn-sim-hover: #fff3e0;
    --btn-sim-active-bg: #e65100;
    --btn-sim-active-text: #fff;
    --btn-sim-active-hover: #bf360c;
    --btn-close-border: #ccc;
    --btn-close-bg: #fff;

    --data-pre-bg: #f5f5f5;

    --timeline-border: #e0e0e0;
    --timeline-dot: #999;
    --timeline-entry-border: #f0f0f0;

    --priority-emergency-color: #d32f2f;
    --priority-emergency-bg: #ffebee;
    --priority-alarm-color: #f57c00;
    --priority-alarm-bg: #fff3e0;
    --priority-warning-color: #fbc02d;
    --priority-warning-bg: #fffde7;
    --priority-caution-color: #1976d2;
    --priority-caution-bg: #e3f2fd;

    --toggle-bg: #e0e0e0;
    --toggle-active-bg: #1976d2;
    --toggle-active-text: #fff;
    --toggle-inactive-bg: transparent;
    --toggle-inactive-text: #666;

    --history-card-bg: #fafafa;
    --history-card-border: #e0e0e0;
    --history-label-color: #888;

    --error-text: #d32f2f;
  }

  @media (prefers-color-scheme: dark) {
    :host {
      --bg-primary: #1e1e1e;
      --bg-secondary: #2a2a2a;
      --bg-hover: #333;
      --text-primary: #e0e0e0;
      --text-secondary: #bbb;
      --text-muted: #999;
      --text-dim: #777;
      --border-primary: #444;
      --border-secondary: #555;

      --badge-state-bg: #333;
      --badge-state-text: #ccc;
      --badge-group-bg: #2a2a2a;
      --badge-group-text: #aaa;
      --badge-stale-bg: #3d3520;
      --badge-stale-text: #d4a017;
      --badge-silenced-bg: #1a1a3e;
      --badge-silenced-text: #7986cb;

      --btn-bg: #2a2a2a;
      --btn-border: #555;
      --btn-ack-border: #388e3c;
      --btn-ack-text: #66bb6a;
      --btn-silence-border: #1565c0;
      --btn-silence-text: #64b5f6;
      --btn-dismiss-border: #666;
      --btn-dismiss-text: #bdbdbd;
      --btn-silence-all-bg: #2a2a2a;
      --btn-silence-all-border: #1565c0;
      --btn-silence-all-text: #64b5f6;
      --btn-silence-all-hover: #1a3a5c;
      --btn-sim-border: #e65100;
      --btn-sim-text: #ff9800;
      --btn-sim-hover: #3d2200;
      --btn-sim-active-bg: #e65100;
      --btn-sim-active-text: #fff;
      --btn-sim-active-hover: #bf360c;
      --btn-close-border: #555;
      --btn-close-bg: #2a2a2a;

      --data-pre-bg: #2a2a2a;

      --timeline-border: #444;
      --timeline-dot: #777;
      --timeline-entry-border: #333;

      --priority-emergency-color: #ef5350;
      --priority-emergency-bg: #3b1a1a;
      --priority-alarm-color: #ffb74d;
      --priority-alarm-bg: #3b2a10;
      --priority-warning-color: #fff176;
      --priority-warning-bg: #3b3510;
      --priority-caution-color: #64b5f6;
      --priority-caution-bg: #1a2a3b;

      --toggle-bg: #333;
      --toggle-active-bg: #1565c0;
      --toggle-active-text: #fff;
      --toggle-inactive-bg: transparent;
      --toggle-inactive-text: #999;

      --history-card-bg: #2a2a2a;
      --history-card-border: #444;
      --history-label-color: #777;

      --error-text: #ef5350;
    }
  }
`
