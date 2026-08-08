import React, { useEffect } from 'react';
import { X } from 'lucide-react';

export function Modal({ open, onClose, title, eyebrow, children, wide = false, id }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className={`modal-shell ${wide ? 'modal-wide' : ''}`} id={id}>
      <div className="modal-header"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      {children}
    </div>
  </div>;
}
