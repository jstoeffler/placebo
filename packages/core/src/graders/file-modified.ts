import type { Change } from '../domain/change.js';
import type { Grade, GraderRef } from '../domain/grade.js';
import type { GraderSpec } from '../domain/suite.js';
import { checkGrade } from './grades.js';

type FileModifiedSpec = Extract<GraderSpec, { type: 'file_modified' }>;

/** Passes if `spec.path` (a leading `./` is ignored) is one of the change's files. */
export function gradeFileModified(spec: FileModifiedSpec, ref: GraderRef, change: Change): Grade {
  const path = spec.path.replace(/^\.\//, '');
  const modified = change.files.includes(path);
  return checkGrade(ref, modified, `${path} is ${modified ? '' : 'not '}part of the change`);
}
