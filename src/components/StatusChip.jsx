import React from 'react';

const labels = { submitted: 'Submitted', supervisor_review: 'Supervisor review', revision_requested: 'Revision requested', supervisor_approved: 'Supervisor approved', library_review: 'Library review', published: 'Published', cleared: 'Cleared', rejected: 'Rejected' };
export function StatusChip({ status }) { return <span className={`status-chip status-${status || 'neutral'}`}><span className="status-dot" />{labels[status] || status || 'Pending'}</span>; }
