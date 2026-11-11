"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface ExpandedCellState {
  projectId: number;
  projectName: string;
  fieldKey: string;
  fieldLabel: string;
  text: string;
  triggerEl: HTMLButtonElement | null;
}

export function ClampedTextCell({
  text,
  projectId,
  projectName,
  fieldKey,
  fieldLabel,
  onExpand,
  children,
}: {
  text: string | null | undefined;
  projectId: number;
  projectName: string;
  fieldKey: string;
  fieldLabel: string;
  onExpand: (state: ExpandedCellState) => void;
  children?: ReactNode;
}) {
  const textRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const value = text ?? "";

  const measureOverflow = useCallback(() => {
    const el = textRef.current;
    if (!el || !value) {
      setIsOverflowing(false);
      return;
    }
    const overflow = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
    setIsOverflowing((prev) => (prev !== overflow ? overflow : prev));
  }, [value]);

  useEffect(() => {
    measureOverflow();
    const el = textRef.current;
    if (!el || !value || typeof ResizeObserver === "undefined") return;
    let frameId = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measureOverflow);
    });
    observer.observe(el);
    const styleObserver =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            cancelAnimationFrame(frameId);
            frameId = requestAnimationFrame(measureOverflow);
          })
        : null;
    styleObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      styleObserver?.disconnect();
    };
  }, [measureOverflow, value]);

  if (!value) {
    return (
      <>
        —
        {children}
      </>
    );
  }

  return (
    <div className="clamped-cell">
      <div className="clamped-cell-row">
        <div
          ref={textRef}
          className="clamped-text-content"
          data-clamped={isOverflowing ? "true" : "false"}
        >
          {value}
        </div>
        {isOverflowing && (
          <button
            ref={buttonRef}
            type="button"
            className="btn icon cell-expand-btn"
            aria-label={`Показать полный текст поля «${fieldLabel}» проекта «${projectName}»`}
            title="Показать полный текст"
            onClick={(e) => {
              e.stopPropagation();
              onExpand({
                projectId,
                projectName,
                fieldKey,
                fieldLabel,
                text: value,
                triggerEl: buttonRef.current,
              });
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="10 2 14 2 14 6" />
              <polyline points="6 14 2 14 2 10" />
              <line x1="14" y1="2" x2="9.5" y2="6.5" />
              <line x1="2" y1="14" x2="6.5" y2="9.5" />
            </svg>
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export function FullTextDialog({
  state,
  onClose,
}: {
  state: ExpandedCellState;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

  const handleClose = useCallback(() => {
    const trigger = state.triggerEl;
    onClose();
    if (trigger && document.body.contains(trigger)) {
      requestAnimationFrame(() => trigger.focus());
    }
  }, [onClose, state.triggerEl]);

  useEffect(() => {
    setCopyStatus("idle");
    closeBtnRef.current?.focus();
  }, [state]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      } else if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleClose]);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(state.text);
        setCopyStatus("copied");
        return;
      }
      throw new Error("Clipboard API unavailable");
    } catch {
      setCopyStatus("error");
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        ref={dialogRef}
        className="card modal full-text-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="full-text-modal-header">
          <h2 id={titleId}>{state.fieldLabel}</h2>
          <div className="muted full-text-modal-subtitle">{state.projectName}</div>
        </div>
        <div
          className="full-text-modal-body"
          data-testid="full-text-modal-content"
          tabIndex={0}
        >
          {state.text}
        </div>
        {copyStatus === "copied" && (
          <div className="ok" role="status" style={{ color: "var(--good)", fontSize: 13 }}>
            Текст скопирован в буфер обмена
          </div>
        )}
        {copyStatus === "error" && (
          <div className="error" role="alert" style={{ color: "var(--bad)", fontSize: 13 }}>
            Не удалось скопировать текст автоматически
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn" onClick={handleCopy}>
            Скопировать
          </button>
          <button ref={closeBtnRef} type="button" className="btn primary" onClick={handleClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
