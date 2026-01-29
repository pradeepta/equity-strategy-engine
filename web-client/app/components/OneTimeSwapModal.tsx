import { useState, useEffect } from "react";

/**
 * One-Time Swap Modal Component
 * Allows users to select which active strategies to evaluate for swapping
 */
export function OneTimeSwapModal({
  strategies,
  isEvaluating,
  onClose,
  onExecute,
}: {
  strategies: any[];
  isEvaluating: boolean;
  onClose: () => void;
  onExecute: (selectedIds: string[]) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);

  // Initialize with all strategies selected
  useEffect(() => {
    const allIds = new Set(strategies.map((s) => s.id));
    setSelectedIds(allIds);
    setSelectAll(true);
  }, [strategies]);

  const toggleStrategy = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
    setSelectAll(newSelected.size === strategies.length);
  };

  const toggleSelectAll = () => {
    if (selectAll) {
      setSelectedIds(new Set());
      setSelectAll(false);
    } else {
      const allIds = new Set(strategies.map((s) => s.id));
      setSelectedIds(allIds);
      setSelectAll(true);
    }
  };

  const handleExecute = () => {
    onExecute(Array.from(selectedIds));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content modal-medium"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "600px" }}
      >
        <div className="modal-header">
          <h2 className="modal-title">Select Strategies to Evaluate</h2>
          <button className="modal-close" onClick={onClose} disabled={isEvaluating}>
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="modal-section">
            <p style={{ marginBottom: "16px", color: "#737373" }}>
              Choose which active strategies to evaluate for potential swaps.
              The AI will analyze market conditions and recommend whether to
              continue or swap each selected strategy.
            </p>

            {strategies.length === 0 ? (
              <div style={{ textAlign: "center", padding: "32px", color: "#737373" }}>
                No active strategies found.
              </div>
            ) : (
              <>
                {/* Select All Checkbox */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "12px",
                    borderRadius: "6px",
                    backgroundColor: "#faf8f5",
                    border: "2px solid #f55036",
                    marginBottom: "12px",
                    cursor: "pointer",
                  }}
                  onClick={toggleSelectAll}
                >
                  <input
                    type="checkbox"
                    checked={selectAll}
                    onChange={toggleSelectAll}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: "18px",
                      height: "18px",
                      marginRight: "12px",
                      cursor: "pointer",
                    }}
                  />
                  <div style={{ fontWeight: 600, fontSize: "14px" }}>
                    Select All ({strategies.length} strategies)
                  </div>
                </div>

                {/* Strategy List */}
                <div
                  style={{
                    maxHeight: "400px",
                    overflowY: "auto",
                    border: "1px solid #ebe6dd",
                    borderRadius: "6px",
                  }}
                >
                  {strategies.map((strategy) => (
                    <div
                      key={strategy.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        padding: "12px 16px",
                        borderBottom: "1px solid #ebe6dd",
                        cursor: "pointer",
                        backgroundColor: selectedIds.has(strategy.id)
                          ? "#fef3f2"
                          : "white",
                        transition: "background-color 0.2s",
                      }}
                      onClick={() => toggleStrategy(strategy.id)}
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(strategy.id)}
                        onChange={() => toggleStrategy(strategy.id)}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          width: "16px",
                          height: "16px",
                          marginRight: "12px",
                          cursor: "pointer",
                        }}
                      />
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: "14px",
                            marginBottom: "4px",
                          }}
                        >
                          {strategy.name}
                        </div>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#737373",
                          }}
                        >
                          {strategy.symbol} • {strategy.timeframe}
                          {strategy.activatedAt && (
                            <>
                              {" "}
                              • Active since{" "}
                              {new Date(strategy.activatedAt).toLocaleString()}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Selection Summary */}
                <div
                  style={{
                    marginTop: "16px",
                    padding: "12px",
                    borderRadius: "6px",
                    backgroundColor: "#f0fdf4",
                    border: "1px solid #86efac",
                  }}
                >
                  <p style={{ fontSize: "13px", color: "#166534" }}>
                    📊 <strong>{selectedIds.size}</strong> strateg
                    {selectedIds.size === 1 ? "y" : "ies"} selected for
                    evaluation
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button
            className="modal-button cancel-button"
            onClick={onClose}
            disabled={isEvaluating}
          >
            Cancel
          </button>
          <button
            className="modal-button confirm-button"
            onClick={handleExecute}
            disabled={isEvaluating || selectedIds.size === 0}
            style={{ backgroundColor: "#f55036" }}
          >
            {isEvaluating
              ? "Evaluating..."
              : `Evaluate ${selectedIds.size} Strateg${selectedIds.size === 1 ? "y" : "ies"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
