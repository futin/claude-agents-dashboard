import { Component, type ReactNode } from 'react';

export const LOAD_FAILED_TEXT = 'This part of the dashboard failed to load — it was probably updated since this tab opened.';

interface Props {
  children: ReactNode;
  /** `float` pins the notice to the bottom of the screen, for a drawer or sheet whose own markup would have been fixed-position; `inline` sits in the flow
   * where the section would have drawn. */
  variant?: 'inline' | 'float';
  /** Injected so the tests can press the button without a `window`. */
  reload?: () => void;
}

interface State { failed: boolean }

/**
 * Catches what a `lazy()` chunk throws when it cannot load — the usual cause a tab left open across a `pnpm build` and restart, which asks for a chunk hash
 * the new build no longer has — and offers a reload. Without it React 18 unmounts the whole root and the page goes white. Render errors below it land here
 * too, which is no worse than the white page they would otherwise give. Keyed or remounted by its caller to recover: once failed it stays failed.
 */
export class LoadBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const reload = this.props.reload ?? (() => window.location.reload());
    return (
      <div className={this.props.variant === 'float' ? 'load-failed float' : 'load-failed'} role="alert">
        <span>{LOAD_FAILED_TEXT}</span>
        <button type="button" onClick={() => reload()}>Reload</button>
      </div>
    );
  }
}
