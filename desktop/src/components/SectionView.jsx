import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, sectionImage, frameFrom } from '../api.js';
import Card from './Card.jsx';
import Confirm from './Confirm.jsx';

/**
 * One of the sections that keeps its own folders: family, artwork.
 *
 * The arrangement is the arrangement on the disk. Whatever folders somebody
 * put their holidays in are the groups they see, because those folders are
 * already the decision they made about how their own files are organised —
 * and a library that quietly reorganises somebody's photographs into
 * something cleverer has taken something away from them.
 *
 * What it does add is a name. A folder called "2019-08 DCIM raw" is a fine
 * name for a folder and a poor heading, so the owner can call it something
 * else without touching what is on the disk.
 *
 * Videos and pictures live side by side here. A video is an ordinary title as
 * far as the rest of the library is concerned, so it opens, plays and resumes
 * like anything else; a picture opens full screen and nothing more.
 */
export function SectionView({ section, label, isOwner, onSelect, onLongPress = null }) {
  const [contents, setContents] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api.sectionContents(section)
      .then(setContents)
      .catch((failure) => setError(failure.message));
  }, [section]);

  useEffect(() => { load(); setOpen(null); }, [load]);

  /* What is in the folder being looked at, or everything if none is. */
  const shown = useMemo(() => {
    if (!contents) return { videos: [], images: [] };
    if (!open) return { videos: contents.videos, images: contents.images };
    return {
      videos: contents.videos.filter((item) => item.folderId === open.id),
      images: contents.images.filter((image) => image.folderId === open.id),
    };
  }, [contents, open]);

  if (error) return <p className="settings-empty" style={{ margin: 40 }}>{error}</p>;
  if (!contents) return null;

  const empty = contents.videos.length === 0 && contents.images.length === 0;

  return (
    <>
      <div className="page-header">
        {open && (
          <button type="button" className="btn btn-secondary btn-back" onClick={() => setOpen(null)}>
            ← Back
          </button>
        )}
        <h1 className="page-title">{open ? open.name : label}</h1>
        <span className="page-sub">
          {[
            shown.videos.length ? shown.videos.length + ' videos' : null,
            shown.images.length ? shown.images.length + ' pictures' : null,
          ].filter(Boolean).join(' · ') || 'Nothing here'}
        </span>

        {isOwner && open && (
          <button type="button" className="chip" onClick={() => setRenaming(open)}>
            Rename
          </button>
        )}
        {isOwner && !open && (
          <button type="button" className="chip see-everything" onClick={() => setAdding(true)}>
            + New folder
          </button>
        )}
      </div>

      {empty && (
        <div className="lists-empty">
          <strong>Nothing here yet</strong>
          <p>
            Point {label} at a folder in Settings → Sections, then scan it. Whatever
            folders are inside become the groups you see here.
          </p>
        </div>
      )}

      {/* The folders, when looking at the section as a whole. */}
      {!open && contents.folders.length > 0 && (
        <div className="section-folders">
          {contents.folders.map((folder) => (
            <button
              type="button"
              className="section-folder"
              key={folder.id}
              onClick={() => setOpen(folder)}
            >
              <span className="section-folder-mark" aria-hidden="true">
                {folder.kind === 'image' ? '▨' : '▶'}
              </span>
              <span className="section-folder-name">
                <strong>{folder.name}</strong>
                <span>
                  {[
                    folder.videos ? folder.videos + ' videos' : null,
                    folder.images ? folder.images + ' pictures' : null,
                  ].filter(Boolean).join(' · ') || 'Empty'}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Videos, drawn as any other title is. */}
      {shown.videos.length > 0 && (
        <>
          {!open && <h2 className="cast-head">Videos</h2>}
          <div className="grid">
            {shown.videos.map((item) => (
              <Card
                key={item.id}
                item={item}
                /*
                 * Wide, and showing a frame out of the video.
                 *
                 * A home video has no poster and never will, so a tall card
                 * would be a tall grey box with a filename in it. A frame from
                 * a third of the way in is what the file actually looks like,
                 * and the shape that suits a frame is the shape of the video.
                 */
                wide
                image={frameFrom(item.video)}
                label={<><strong>{item.title}</strong></>}
                onClick={(event) => onSelect(item, event)}
                onLongPress={onLongPress ? () => onLongPress(item) : null}
              />
            ))}
          </div>
        </>
      )}

      {/* Pictures. No labels: a wall of them reads better than a list. */}
      {shown.images.length > 0 && (
        <>
          {!open && <h2 className="cast-head">Pictures</h2>}
          <div className="mosaic">
            {shown.images.map((image) => (
              <button
                type="button"
                className="mosaic-tile"
                key={image.id}
                title={image.name}
                aria-label={image.name}
                onClick={() => setViewing(image)}
              >
                <img src={sectionImage(section, image.id)} alt="" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        </>
      )}

      {/* One picture, over everything, dismissed by pressing anywhere. */}
      {viewing && (
        <div className="picture-view" onClick={() => setViewing(null)} role="presentation">
          <img src={sectionImage(section, viewing.id)} alt={viewing.name} />
          <span className="picture-name">{viewing.name}</span>
        </div>
      )}

      {renaming && (
        <Confirm
          title="What should this be called?"
          body="The heading only. The folder on the disk keeps its own name."
          confirmLabel="Rename"
          danger={false}
          field={{ label: 'Name', value: renaming.name, placeholder: 'Summer 2019' }}
          onCancel={() => setRenaming(null)}
          onConfirm={async (name) => {
            const folder = renaming;
            setRenaming(null);
            try {
              await api.renameSectionFolder(section, folder.id, name);
              setOpen((was) => (was && was.id === folder.id ? { ...was, name } : was));
              load();
            } catch (failure) { setError(failure.message); }
          }}
        />
      )}

      {adding && (
        <Confirm
          title={'A new folder in ' + label}
          body="Made on the disk, under the first folder this section was given."
          confirmLabel="Make it"
          danger={false}
          field={{ label: 'Name', value: '', placeholder: 'Holidays' }}
          onCancel={() => setAdding(false)}
          onConfirm={async (name) => {
            setAdding(false);
            try {
              await api.addSectionFolder(section, name);
              load();
            } catch (failure) { setError(failure.message); }
          }}
        />
      )}
    </>
  );
}

export default SectionView;
