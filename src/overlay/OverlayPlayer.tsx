import { useEffect, useRef, useState } from 'react';
import { drawOverlay, type MaskCache } from './drawOverlay';
import type { OverlayData } from './overlayData';

interface Props {
  readonly videoUrl: string;
  readonly data: OverlayData;
}

const RATES = [1, 0.25, 0.1] as const;

/**
 * Plays a local clip with the overlay drawn on a canvas the clip's size,
 * stacked over the video and scaled with it. Redraws on every presented
 * frame (requestVideoFrameCallback, which reports the frame's media time)
 * and on seeks, so the overlay matches the frame on screen when paused or
 * scrubbed too.
 */
export function OverlayPlayer({ videoUrl, data }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sizeWarning, setSizeWarning] = useState<string | null>(null);
  const [rate, setRate] = useState<number>(1);
  const { width, height } = data.calibration.imageSize;

  useEffect(() => {
    const video = videoRef.current;
    const ctx = canvasRef.current?.getContext('2d');
    if (!video || !ctx) return;
    const cache: MaskCache = new WeakMap();
    const paint = (t: number) => drawOverlay(ctx, data, t, cache);

    let frameHandle = 0;
    let rafHandle = 0;
    // Older Firefox lacks requestVideoFrameCallback; fall back to polling currentTime each animation frame.
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame: VideoFrameRequestCallback = (_now, meta) => {
        paint(meta.mediaTime);
        frameHandle = video.requestVideoFrameCallback(onFrame);
      };
      frameHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      const onAnimationFrame = () => {
        paint(video.currentTime);
        rafHandle = requestAnimationFrame(onAnimationFrame);
      };
      rafHandle = requestAnimationFrame(onAnimationFrame);
    }
    const onSeeked = () => paint(video.currentTime);
    const onMetadata = () => {
      const sceneAspect = width / height;
      const clipAspect = video.videoWidth / video.videoHeight;
      setSizeWarning(
        Math.abs(sceneAspect - clipAspect) > 0.01
          ? `The clip is ${video.videoWidth}×${video.videoHeight} but scene.json was read on a ${width}×${height} frame; the overlay will not line up.`
          : null,
      );
      paint(video.currentTime);
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadedmetadata', onMetadata);
    paint(video.currentTime);
    return () => {
      if (frameHandle) video.cancelVideoFrameCallback(frameHandle);
      if (rafHandle) cancelAnimationFrame(rafHandle);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadedmetadata', onMetadata);
    };
  }, [data, width, height]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate]);

  return (
    <div>
      <div style={{ position: 'relative', background: '#000', aspectRatio: `${width} / ${height}` }}>
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          muted
          playsInline
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        />
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          aria-label="Overlay: SAM masks, measured trail and simulated ball"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        />
      </div>
      <p>
        Speed:{' '}
        {RATES.map((r) => (
          <label key={r} style={{ marginRight: 12 }}>
            <input type="radio" name="rate" checked={rate === r} onChange={() => setRate(r)} /> {r}×
          </label>
        ))}
      </p>
      {sizeWarning && <p role="alert">{sizeWarning}</p>}
    </div>
  );
}
