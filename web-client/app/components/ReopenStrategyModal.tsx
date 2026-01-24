/**
 * Reopen Strategy Modal Component
 * Allows users to reopen a closed strategy with a required reason
 */
export function ReopenStrategyModal({
  strategy,
  reopenReason,
  isReopening,
  onClose,
  onReasonChange,
  onConfirm,
}: {
  strategy: any;
  reopenReason: string;
  isReopening: boolean;
  onClose: () => void;
  onReasonChange: (reason: string) => void;
  onConfirm: () => void;
}) {
  if (!strategy) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content modal-small"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">Reopen Strategy</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-section">
            <p style={{ marginBottom: "16px", color: "#737373" }}>
              You are about to reopen <strong>{strategy.name}</strong> (
              {strategy.symbol}). The strategy will be set to PENDING status
              and the orchestrator will automatically activate it.
            </p>
            <div className="modal-field">
              <div className="modal-label">Reason for reopening *</div>
              <textarea
                className="reopen-reason-input"
                placeholder="Enter reason (e.g., Market conditions improved, Strategy adjustments made, etc.)"
                value={reopenReason}
                onChange={(e) => onReasonChange(e.target.value)}
                rows={3}
                disabled={isReopening}
              />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button
            className="modal-button cancel-button"
            onClick={onClose}
            disabled={isReopening}
          >
            Cancel
          </button>
          <button
            className="modal-button confirm-reopen-button"
            onClick={onConfirm}
            disabled={isReopening || !reopenReason.trim()}
          >
            {isReopening ? "Reopening..." : "Reopen Strategy"}
          </button>
        </div>
      </div>
    </div>
  );
}
