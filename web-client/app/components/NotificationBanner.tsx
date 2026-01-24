/**
 * Notification Banner Component
 * Displays success/error notifications with auto-dismiss functionality
 */
export function NotificationBanner({
  notification,
  onClose,
}: {
  notification: { type: "success" | "error"; message: string } | null;
  onClose: () => void;
}) {
  if (!notification) return null;

  return (
    <div className={`notification ${notification.type}`}>
      <span>{notification.message}</span>
      <button className="notification-close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
