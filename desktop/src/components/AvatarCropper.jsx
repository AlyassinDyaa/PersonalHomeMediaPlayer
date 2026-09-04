import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Choose which part of a photograph becomes a profile's face.
 *
 * A face is shown in a circle, so a photograph has to be cropped square
 * whatever happens. Cropping to the middle automatically gets it wrong often
 * enough — heads are rarely in the middle of a picture — so this lets the
 * picture be dragged and scaled until the right part is inside the ring.
 *
 * The result is drawn once at the end, at the size it will actually be shown,
 * and encoded as a JPEG. That is the whole of the compression: a photograph
 * from a phone arrives at several megabytes and leaves at a few tens of
 * kilobytes, because nothing bigger than the circle is ever kept.
 */

/** What the face is drawn at. Twice the largest place it appears, for sharp screens. */
const OUTPUT_SIDE = 320;
/** How large the ring is on screen while choosing. */
const VIEW_SIDE = 240;
/** The longest edge kept of the original, so the crop can be redone later. */
const SOURCE_SIDE = 1024;

export function AvatarCropper({ file = null, src = null, onCancel, onDone, busy = false }) {
  const [image, setImage] = useState(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState(null);
  const dragging = useRef(null);

  /*
   * Load either a newly chosen file or the picture already saved.
   *
   * Editing an existing face works on the picture it was cut from rather than
   * on the face itself: cropping a crop can only ever lose more of the
   * photograph, and cannot bring back what was cut away the first time.
   */
  useEffect(() => {
    if (!file && !src) return undefined;
    let alive = true;

    const show = (source) => {
      const loaded = new Image();
      loaded.onerror = () => alive && setError('That picture could not be opened');
      loaded.onload = () => {
        if (!alive) return;
        setImage(loaded);
        setScale(1);
        setOffset({ x: 0, y: 0 });
      };
      loaded.src = source;
    };

    if (file) {
      const reader = new FileReader();
      reader.onerror = () => alive && setError('That file could not be read');
      reader.onload = () => show(reader.result);
      reader.readAsDataURL(file);
    } else {
      show(src);
    }

    return () => { alive = false; };
  }, [file, src]);

  /** The scale at which the picture exactly covers the ring. */
  const baseScale = image ? VIEW_SIDE / Math.min(image.width, image.height) : 1;

  const startDrag = useCallback((event) => {
    const point = event.touches?.[0] ?? event;
    dragging.current = { x: point.clientX, y: point.clientY, from: offset };
  }, [offset]);

  const onDrag = useCallback((event) => {
    if (!dragging.current) return;
    const point = event.touches?.[0] ?? event;
    setOffset({
      x: dragging.current.from.x + (point.clientX - dragging.current.x),
      y: dragging.current.from.y + (point.clientY - dragging.current.y),
    });
  }, []);

  const endDrag = useCallback(() => { dragging.current = null; }, []);

  /**
   * Draw the chosen square once, at the size it will be shown.
   *
   * The same arithmetic as the preview, at output scale — so what was inside
   * the ring is what gets saved.
   */
  const save = useCallback(() => {
    if (!image) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIDE;
    canvas.height = OUTPUT_SIDE;
    const context = canvas.getContext('2d');
    context.fillStyle = '#16161d';
    context.fillRect(0, 0, OUTPUT_SIDE, OUTPUT_SIDE);

    const ratio = OUTPUT_SIDE / VIEW_SIDE;
    const drawn = baseScale * scale * ratio;
    const width = image.width * drawn;
    const height = image.height * drawn;
    const x = (OUTPUT_SIDE - width) / 2 + offset.x * ratio;
    const y = (OUTPUT_SIDE - height) / 2 + offset.y * ratio;

    context.drawImage(image, x, y, width, height);

    /*
     * The picture is kept alongside the face, scaled down to a size worth
     * re-cropping and no larger. Only when it came from a file: editing an
     * existing face is already working from the stored source, and rewriting
     * it each time would slowly cook it through repeated re-encoding.
     */
    let source = null;
    if (file) {
      const longest = Math.max(image.width, image.height);
      const shrink = longest > SOURCE_SIDE ? SOURCE_SIDE / longest : 1;
      const keep = document.createElement('canvas');
      keep.width = Math.round(image.width * shrink);
      keep.height = Math.round(image.height * shrink);
      keep.getContext('2d').drawImage(image, 0, 0, keep.width, keep.height);
      source = keep.toDataURL('image/jpeg', 0.85);
    }

    // 0.82 is where this stops being visibly lossy for a face this small.
    onDone(canvas.toDataURL('image/jpeg', 0.82), source);
  }, [image, baseScale, scale, offset, onDone, file]);

  if (error) {
    return (
      <div className="cropper">
        <p className="settings-hint">{error}</p>
        <div className="settings-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Close</button>
        </div>
      </div>
    );
  }

  if (!image) return <div className="cropper"><div className="spinner" /></div>;

  const drawn = baseScale * scale;
  return (
    <div className="cropper">
      <div
        className="cropper-ring"
        style={{ width: VIEW_SIDE, height: VIEW_SIDE }}
        onMouseDown={startDrag}
        onMouseMove={onDrag}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onTouchStart={startDrag}
        onTouchMove={onDrag}
        onTouchEnd={endDrag}
      >
        <img
          src={image.src}
          alt=""
          draggable={false}
          style={{
            width: image.width * drawn,
            height: image.height * drawn,
            // Centred on the ring first, then moved by the drag. Percentage
            // margins would resolve against the ring rather than the picture,
            // which centres nothing.
            transform: 'translate(calc(-50% + ' + offset.x + 'px), calc(-50% + ' + offset.y + 'px))',
          }}
        />
      </div>

      <label className="cropper-zoom">
        <span>Zoom</span>
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={scale}
          onChange={(event) => setScale(Number(event.target.value))}
        />
      </label>

      <p className="settings-hint" style={{ margin: 0 }}>
        Drag the picture to move it. Only what is inside the frame is kept.
      </p>

      <div className="settings-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Use this picture'}
        </button>
      </div>
    </div>
  );
}

export default AvatarCropper;
