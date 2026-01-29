/**
 * Force Deploy Modal Component
 * Allows users to manually trigger entry orders with warning and confirmation
 */

export function ForceDeployModal({
  strategy,
  forceDeployReason,
  isDeploying,
  onClose,
  onReasonChange,
  onConfirm,
}: {
  strategy: any;
  forceDeployReason: string;
  isDeploying: boolean;
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
          <h2 className="modal-title">⚠️ Force Deploy Strategy</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-section">
            {/* Warning message */}
            <div className="warning-box" style={{
              padding: '12px',
              backgroundColor: '#fef3c7',
              border: '1px solid #f59e0b',
              borderRadius: '6px',
              marginBottom: '16px',
            }}>
              <strong>⚠️ Warning:</strong> This will bypass normal entry conditions
              and submit orders immediately. The strategy will still monitor stop
              loss and invalidation rules after entry.
            </div>

            {/* Strategy info */}
            <p style={{ marginBottom: '16px', color: '#737373' }}>
              You are about to force deploy{' '}
              <strong>{strategy.name}</strong> ({strategy.symbol}).
            </p>

            {/* Current state display */}
            <div style={{ marginBottom: '16px' }}>
              <strong>Current State:</strong>{' '}
              <span className={`status-badge status-${strategy.currentState?.toLowerCase()}`}>
                {strategy.currentState || 'UNKNOWN'}
              </span>
              <span style={{ marginLeft: '12px', color: '#737373' }}>
                ({strategy.openOrderCount || 0} open orders)
              </span>
            </div>

            {/* Reason input */}
            <div className="modal-field">
              <div className="modal-label">Reason for force deploy *</div>
              <textarea
                className="force-deploy-reason-input"
                placeholder="Enter reason (e.g., Market opportunity detected, Testing execution, etc.)"
                value={forceDeployReason}
                onChange={(e) => onReasonChange(e.target.value)}
                rows={3}
                disabled={isDeploying}
              />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button
            className="modal-button cancel-button"
            onClick={onClose}
            disabled={isDeploying}
          >
            Cancel
          </button>
          <button
            className="modal-button confirm-force-deploy-button"
            onClick={onConfirm}
            disabled={isDeploying || !forceDeployReason.trim()}
            style={{
              backgroundColor: '#f59e0b',
              color: 'white',
            }}
          >
            {isDeploying ? 'Deploying...' : 'Force Deploy Now'}
          </button>
        </div>
      </div>
    </div>
  );
}
