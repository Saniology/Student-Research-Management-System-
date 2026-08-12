import React from 'react';

export function Skeleton({ className = '' }) { return <span className={`skeleton ${className}`} aria-hidden="true" />; }

export function RepositorySkeleton({ count = 6 }) {
  return <div className="repo-grid skeleton-repository-grid" aria-label="Loading repository" aria-busy="true">
    {Array.from({ length: count }, (_, index) => <article className="skeleton-repository-card" key={index}>
      <div className="skeleton-repository-meta"><Skeleton className="skeleton-tag" /><Skeleton className="skeleton-meta-line" /></div>
      <Skeleton className="skeleton-repository-title" />
      <div className="skeleton-repository-copy"><Skeleton /><Skeleton /><Skeleton className="short" /></div>
      <div className="skeleton-repository-actions"><Skeleton /><Skeleton /></div>
    </article>)}
  </div>;
}

export function PageSkeleton({ role = 'landing' }) {
  if (role === 'landing') return <div className="skeleton-page skeleton-landing" aria-label="Loading portal">
    <div className="skeleton-hero-copy"><Skeleton className="skeleton-pill" /><Skeleton className="skeleton-title" /><Skeleton className="skeleton-line wide" /><Skeleton className="skeleton-line" /><div className="skeleton-actions"><Skeleton /><Skeleton /><Skeleton /></div></div>
    <div className="skeleton-panel"><Skeleton className="skeleton-line short" />{[1, 2, 3, 4].map(item => <Skeleton className="skeleton-card-line" key={item} />)}</div>
  </div>;
  return <div className={`skeleton-page skeleton-workspace skeleton-${role}`} aria-label={`Loading ${role} workspace`}>
    <div className="skeleton-workspace-head"><div><Skeleton className="skeleton-line short" /><Skeleton className="skeleton-heading" /></div><Skeleton className="skeleton-button" /></div>
    <div className="skeleton-metrics">{[1, 2, 3, 4].map(item => <Skeleton key={item} className="skeleton-metric" />)}</div>
    <div className="skeleton-grid">{[1, 2, 3].map(item => <div className="skeleton-surface" key={item}><Skeleton className="skeleton-line short" /><Skeleton className="skeleton-heading small" /><Skeleton className="skeleton-block" /><Skeleton className="skeleton-line" /><Skeleton className="skeleton-line short" /></div>)}</div>
  </div>;
}
