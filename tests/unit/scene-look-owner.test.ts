import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLookOwner } from '../../src/scene/look-owner';

/**
 * Two meshes over one shared texture: the shape a parsed look has (the garment and the
 * mannequin share the file's texture objects), with dispose spies on everything retire walks.
 */
function fixture() {
  const texture = new Texture();
  const materials = [
    new MeshStandardMaterial({ name: 'assigned', map: texture, normalMap: texture }),
    new MeshStandardMaterial({ name: 'parked' }),
  ];
  const meshes = materials.map((material) => new Mesh(new BoxGeometry(), material));
  const root = new Group();
  root.add(...meshes);
  const spies = {
    geometries: meshes.map((mesh) => vi.spyOn(mesh.geometry, 'dispose')),
    materials: materials.map((material) => vi.spyOn(material, 'dispose')),
    texture: vi.spyOn(texture, 'dispose'),
  };
  return { root, materials, meshes, texture, spies };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLookOwner', () => {
  it('releases collected geometry, materials and their textures exactly once', () => {
    const { root, spies } = fixture();
    const owner = createLookOwner();
    owner.collect(root);
    expect(owner.retired).toBe(false);

    owner.retire();

    expect(owner.retired).toBe(true);
    expect(spies.geometries[0]).toHaveBeenCalledTimes(1);
    expect(spies.materials[0]).toHaveBeenCalledTimes(1);
    // The texture sits in two slots of one material; it is still one resource, one event.
    expect(spies.texture).toHaveBeenCalledTimes(1);
    expect(owner.materials.size).toBe(0);
  });

  it('collects the material a variant swap parked on a mesh', () => {
    const { root, meshes, spies } = fixture();
    // Parked on purpose: no mesh wears this material, so only the parked-original collection
    // can reach it.
    const parked = new MeshStandardMaterial({ name: 'parked-elsewhere' });
    const parkedDispose = vi.spyOn(parked, 'dispose');
    meshes[0].userData['originalMaterial'] = parked;
    const owner = createLookOwner();
    owner.collect(root);

    owner.retire();

    expect(parkedDispose).toHaveBeenCalledTimes(1);
    expect(spies.materials[1]).toHaveBeenCalledTimes(1);
  });

  it('keeps registered materials visible until retirement', () => {
    const { spies } = fixture();
    const owner = createLookOwner();
    const acquired = new MeshStandardMaterial({ name: 'acquired' });
    const acquiredDispose = vi.spyOn(acquired, 'dispose');

    owner.register(acquired);
    expect(owner.materials.has(acquired)).toBe(true);
    expect(spies.materials[0]).not.toHaveBeenCalled();

    owner.retire();
    expect(acquiredDispose).toHaveBeenCalledTimes(1);
  });

  it('releases a registration that arrives after retirement, without re-releasing its texture', () => {
    const { root, materials, texture, spies } = fixture();
    const owner = createLookOwner();
    owner.collect(root);
    owner.retire();

    // The parser resolved this after the look left the screen; its texture is shared with
    // what retirement already released, so only the material is new.
    const late = new MeshStandardMaterial({ name: 'late', map: texture });
    const lateDispose = vi.spyOn(late, 'dispose');
    owner.register(late);

    expect(lateDispose).toHaveBeenCalledTimes(1);
    expect(spies.texture).toHaveBeenCalledTimes(1);
    expect(materials[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('releases resources collected after retirement the same way', () => {
    const { root, spies } = fixture();
    const owner = createLookOwner();
    owner.retire();

    owner.collect(root);

    expect(spies.geometries[0]).toHaveBeenCalledTimes(1);
    expect(spies.materials[0]).toHaveBeenCalledTimes(1);
    expect(spies.texture).toHaveBeenCalledTimes(1);
  });

  it('never disposes anything twice, however often it is asked', () => {
    const { root, materials, spies } = fixture();
    const owner = createLookOwner();
    owner.collect(root);
    owner.retire();
    owner.retire();
    owner.register(materials[0]);
    owner.collect(root);

    expect(spies.geometries[0]).toHaveBeenCalledTimes(1);
    expect(spies.geometries[1]).toHaveBeenCalledTimes(1);
    expect(spies.materials[0]).toHaveBeenCalledTimes(1);
    expect(spies.materials[1]).toHaveBeenCalledTimes(1);
    expect(spies.texture).toHaveBeenCalledTimes(1);
  });

  it('attempts every remaining disposal when a geometry disposer throws, and reports the error', () => {
    const { root, spies } = fixture();
    spies.geometries[0].mockImplementation(() => {
      throw new Error('geometry release failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const owner = createLookOwner();
    owner.collect(root);

    const errors = owner.retire();

    expect(errors.map((error) => error.message)).toEqual(['geometry release failed']);
    expect(spies.geometries[0]).toHaveBeenCalledTimes(1);
    expect(spies.geometries[1]).toHaveBeenCalledTimes(1);
    expect(spies.materials[0]).toHaveBeenCalledTimes(1);
    expect(spies.materials[1]).toHaveBeenCalledTimes(1);
    expect(spies.texture).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // A failed first pass leaves nothing to retry and never throws at the caller.
    expect(owner.retire()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps releasing when a disposer throws a value that cannot be printed', () => {
    const { root, spies } = fixture();
    const unprintable: unknown = Object.create(null);
    spies.geometries[0].mockImplementation(() => {
      throw unprintable;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const owner = createLookOwner();
    owner.collect(root);

    const errors = owner.retire();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.cause).toBe(unprintable);
    expect(spies.geometries[1]).toHaveBeenCalledTimes(1);
    expect(spies.materials[0]).toHaveBeenCalledTimes(1);
    expect(spies.materials[1]).toHaveBeenCalledTimes(1);
    expect(spies.texture).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(owner.retire()).toEqual([]);
  });

  it('releases a throwing material\'s textures and the rest of the look, and reports the error', () => {
    const { root, spies } = fixture();
    spies.materials[0].mockImplementation(() => {
      throw new Error('material release failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const owner = createLookOwner();
    owner.collect(root);

    const errors = owner.retire();

    expect(errors.map((error) => error.message)).toEqual(['material release failed']);
    expect(spies.geometries[0]).toHaveBeenCalledTimes(1);
    expect(spies.geometries[1]).toHaveBeenCalledTimes(1);
    expect(spies.materials[0]).toHaveBeenCalledTimes(1);
    expect(spies.materials[1]).toHaveBeenCalledTimes(1);
    // The texture belongs to the look, not to the material's success: it is attempted anyway.
    expect(spies.texture).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('attempts every disposal when a texture disposer throws, and reports the error', () => {
    const { root, spies } = fixture();
    spies.texture.mockImplementation(() => {
      throw new Error('texture release failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const owner = createLookOwner();
    owner.collect(root);

    const errors = owner.retire();

    expect(errors.map((error) => error.message)).toEqual(['texture release failed']);
    expect(spies.geometries[0]).toHaveBeenCalledTimes(1);
    expect(spies.geometries[1]).toHaveBeenCalledTimes(1);
    expect(spies.materials[0]).toHaveBeenCalledTimes(1);
    expect(spies.materials[1]).toHaveBeenCalledTimes(1);
    expect(spies.texture).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
