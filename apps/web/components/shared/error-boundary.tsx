'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './feedback/error-state';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Generic application-wide render-error boundary. Standing in for
 * Sentry's ErrorBoundary: wiring @sentry/nextjs (DSN, instrumentation
 * config, source maps) is a dedicated observability task and out of scope
 * for this component-library phase. Same "catch render errors, show a
 * fallback" contract, so swapping it in later is a drop-in change at this
 * one call site (components/shared/providers.tsx).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled application error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <ErrorState
            title="Application error"
            description="Something went wrong. Please refresh the page."
            retry={() => this.setState({ hasError: false })}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
