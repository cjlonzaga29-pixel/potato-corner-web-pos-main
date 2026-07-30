'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './feedback/error-state';

interface WidgetErrorBoundaryProps {
  children: ReactNode;
  /** Shown in the fallback so a user can tell which card/section failed. */
  label?: string;
}

interface WidgetErrorBoundaryState {
  hasError: boolean;
}

/**
 * Same catch-a-render-error contract as the app-wide ErrorBoundary
 * (components/shared/error-boundary.tsx), scoped to one dashboard/report
 * widget instead of the whole page. A render crash in one chart or card
 * (e.g. an unguarded .reduce()/.map() over data a 422 left undefined)
 * replaces only that widget with an inline fallback, leaving every other
 * card on the dashboard interactive.
 */
export class WidgetErrorBoundary extends Component<WidgetErrorBoundaryProps, WidgetErrorBoundaryState> {
  state: WidgetErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): WidgetErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Widget render error${this.props.label ? ` (${this.props.label})` : ''}:`, error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorState
          title={this.props.label ? `${this.props.label} failed to load` : 'This section failed to load'}
          description="The rest of the dashboard is unaffected. Try refreshing the page."
          retry={() => this.setState({ hasError: false })}
        />
      );
    }
    return this.props.children;
  }
}
