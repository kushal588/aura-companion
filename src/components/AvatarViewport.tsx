import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAura } from '../app/store';
import type { ExpressionName, Gesture } from '../types/emotion';
import { EXPRESSIONS, GESTURES } from '../types/emotion';
import { formatBytes } from '../avatar/VRMAssetManager';
import { getEngine } from '../app/store';

/**
 * 3D character viewport (PLAN §3.1).
 *
 * The canvas is handed to the engine once; React never touches WebGL state. The
 * overlay exposes the sandbox controls: expression previews, one-shot
 * animations, camera reset and the avatar summary.
 */
export function AvatarViewport(): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const attachCanvas = useAura((state) => state.attachCanvas);
  const mood = useAura((state) => state.mood);
  const speaking = useAura((state) => state.speaking);
  const assetSummary = useAura((state) => state.assetSummary);
  const quality = useAura((state) => state.quality);
  const reducedMotion = useAura((state) => state.settings.reducedMotion);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (canvasRef.current) attachCanvas(canvasRef.current);
  }, [attachCanvas]);

  const previewExpression = (expression: ExpressionName): void => {
    getEngine()?.previewExpression(expression);
  };

  const playGesture = (gesture: Gesture): void => {
    getEngine()?.previewGesture(gesture);
  };

  return (
    <div className={`stage ${reducedMotion ? 'stage--reduced' : ''}`}>
      <canvas ref={canvasRef} className="stage__canvas" aria-label="3D character viewport" />

      <div className="stage__badge" title="Current mood">
        <span className={`mood mood--${mood.emotion}`} />
        <span>{mood.emotion}</span>
        {speaking && <span className="pill">speaking</span>}
      </div>

      <div className="stage__controls" role="toolbar" aria-label="Character preview controls">
        <details>
          <summary>Expressions</summary>
          <div className="chiprow">
            {EXPRESSIONS.map((expression) => (
              <button key={expression} type="button" onClick={() => previewExpression(expression)}>
                {expression}
              </button>
            ))}
          </div>
        </details>
        <details>
          <summary>Animation</summary>
          <div className="chiprow">
            {GESTURES.filter((gesture) => gesture !== 'none').map((gesture) => (
              <button key={gesture} type="button" onClick={() => playGesture(gesture)}>
                {gesture.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </details>
        <button type="button" onClick={() => getEngine()?.resetCamera()}>
          Reset view
        </button>
        <button type="button" onClick={() => setShowDetails((value) => !value)}>
          {showDetails ? 'Hide info' : 'Info'}
        </button>
      </div>

      {showDetails && (
        <div className="stage__info">
          <strong>{assetSummary ? `VRM ${assetSummary.vrmVersion} avatar` : 'Built-in placeholder character'}</strong>
          <span>Quality tier: {quality} (auto-adjusts to frame rate)</span>
          {assetSummary && (
            <>
              <span>
                Bones: {assetSummary.bones} · Triangles: {assetSummary.triangles.toLocaleString()} · Textures:{' '}
                {formatBytes(assetSummary.textureBytes)}
              </span>
              <span>Expressions: {assetSummary.expressions.length || 'none reported'}</span>
              <span>Animation clips: {assetSummary.clips.length || 'none'}</span>
              {assetSummary.warnings.map((warning) => (
                <span key={warning} className="warn">
                  {warning}
                </span>
              ))}
            </>
          )}
          <span className="muted">
            Drag to orbit, scroll to zoom, double-click to reset. Your avatar file is stored locally and never uploaded.
          </span>
        </div>
      )}
    </div>
  );
}
