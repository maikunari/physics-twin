import { useEffect, useRef, useState } from 'react';
import { drawOverlay, type MaskCache, type PredictOverlay, type WhatIfOverlay } from './drawOverlay';
import type { OverlayData } from './overlayData';

interface Props {
  readonly videoUrl: string;
  readonly data: OverlayData;
  /** The predict step: while not revealed the clip is held at the freeze. */
  readonly predict?: PredictOverlay | null;
  /** The what-if's amber run, drawn over the same clip. */
  readonly whatIf?: WhatIfOverlay | null;
  /** Called with the media time of every frame drawn. */
  readonly onTime?: (t: number) => void;
}

const RATES = [1, 0.25, 0.1] as const;

/**
 * Plays a local clip with the overlay drawn on a canvas the clip's size,
 * stacked over the video and scaled with it. Redraws on every presented
 * frame (requestVideoFrameCallback, which reports the frame's media time)
 * and on seeks, so the overlay matches the frame on screen when paused or
 * scrubbed too. Once a prediction is committed the clip is held at the
 * freeze until the reveal, which plays on from there.
 */
export function OverlayPlayer({ videoUrl, data, predict = null, whatIf = null, onTime }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sizeWarning, setSizeWarning] = useState<string | null>(null);
  const [rate, setRate] = useState<number>(1);
  const { width, height } = data.calibration.imageSize;
  const onTimeRef = useRef(onTime);
  useEffect(() => {
    onTimeRef.current = onTime;
  }, [onTime]);

  // Before the reveal the clip may play up to the freeze and no further.
  const holdAtSec = predict && !predict.revealed ? predict.clockZeroSec + predict.prediction.freezeSec : null;
  const revealFromSec = predict?.revealed ? predict.clockZeroSec + predict.prediction.freezeSec : null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || holdAtSec === null) return;
    const hold = () => {
      if (video.currentTime > holdAtSec) {
        video.pause();
        video.currentTime = holdAtSec;
      }
    };
    video.pause();
    video.currentTime = holdAtSec;
    video.addEventListener('timeupdate', hold);
    video.addEventListener('seeking', hold);
    video.addEventListener('play', hold);
    return () => {
      video.removeEventListener('timeupdate', hold);
      video.removeEventListener('seeking', hold);
      video.removeEventListener('play', hold);
    };
  }, [holdAtSec]);

  // The reveal plays on from the freeze.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || revealFromSec === null) return;
    video.currentTime = revealFromSec;
    void video.play().catch(() => undefined);
  }, [revealFromSec]);

  useEffect(() => {
    const video = videoRef.current;
    const ctx = canvasRef.current?.getContext('2d');
    if (!video || !ctx) return;
    const cache: MaskCache = new WeakMap();
    const paint = (t: number) => {
      // Never draw past the freeze while the clip is held, even for the one frame before the pause lands.
      const shown = holdAtSec === null ? t : Math.min(t, holdAtSec);
      drawOverlay(ctx, data, shown, cache, predict, whatIf);
      onTimeRef.current?.(shown);
    };

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
    const onEnded = () => paint(video.duration);
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
    video.addEventListener('ended', onEnded);
    video.addEventListener('loadedmetadata', onMetadata);
    paint(video.currentTime);
    return () => {
      if (frameHandle) video.cancelVideoFrameCallback(frameHandle);
      if (rafHandle) cancelAnimationFrame(rafHandle);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('loadedmetadata', onMetadata);
    };
  }, [data, width, height, predict, whatIf, holdAtSec]);

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
