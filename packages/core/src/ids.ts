import { v7 as uuidv7 } from 'uuid';

/** Time-ordered UUID (v7) used for every primary key so indexes stay append-friendly. */
export function newId(): string {
  return uuidv7();
}
