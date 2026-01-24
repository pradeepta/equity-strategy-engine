/**
 * Close Strategy Modal Component
 * Allows users to close an active strategy with a required reason
 */
export function CloseStrategyModal({
  strategy,
  closeReason,
  isClosing,
  onClose,
  onReasonChange,
  onConfirm,
}: {
  strategy: any;
  closeReason: string;
  isClosing: boolean;
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
          <h2 className="modal-title">Close Strategy</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-section">
            <p style={{ marginBottom: "16px", color: "#737373" }}>
              You are about to close <strong>{strategy.name}</strong> (
              {strategy.symbol}). This action will stop all trading activity
              for this strategy.
            </p>
            <div className="modal-field">
              <div className="modal-label">Reason for closing *</div>
              <textarea
                className="close-reason-input"
                placeholder="Enter reason (e.g., Market conditions unfavorable, Risk limit reached, etc.)"
                value={closeReason}
                onChange={(e) => onReasonChange(e.target.value)}
                rows={3}
                disabled={isClosing}
              />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button
            className="modal-button cancel-button"
            onClick={onClose}
            disabled={isClosing}
          >
            Cancel
          </button>
          <button
            className="modal-button confirm-close-button"
            onClick={onConfirm}
            disabled={isClosing || !closeReason.trim()}
          >
            {isClosing ? "Closing..." : "Close Strategy"}
          </button>
        </div>
      </div>
    </div>
  );
}
