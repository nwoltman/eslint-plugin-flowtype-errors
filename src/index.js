/* @flow */

import path from 'path';
import fs from 'fs';
// $FlowIgnore
import findUp from 'find-up';
import {
  type CollectOutputElement,
  FlowSeverity,
  collect,
  coverage
} from './collect';
import getProgram, { type Program, type Loc } from './get-program';

type EslintContext = {
  getAllComments: () => { value: string }[],
  getFilename: () => string,
  getSourceCode: () => Object,
  report: ({ loc: Loc, message: string }) => void,
  settings: ?{
    'flowtype-errors': ?{
      stopOnExit?: any
    }
  },
  options: any[]
};

type Info = {
  flowDir: string,
  program: Program
};

const DEFAULT_LOC = {
  start: {
    line: 1,
    column: 0
  },
  end: {
    line: 1,
    column: 0
  }
};

function lookupInfo(
  context: EslintContext,
  source: Object,
  node: Object
): ?Info {
  const flowconfigFile = findUp.sync('.flowconfig', {
    cwd: path.dirname(context.getFilename())
  });

  if (flowconfigFile == null) {
    const program = getProgram(source, node);
    context.report({
      loc: program ? program.loc : DEFAULT_LOC,
      message: "Could not find '.flowconfig' file"
    });
    return null;
  }

  const flowDir = path.dirname(flowconfigFile);

  const runOnAllFiles = fs
    .readFileSync(flowconfigFile, 'utf8')
    .includes('all=true');

  const shouldRun =
    runOnAllFiles ||
    source.getAllComments().some(comment => /@flow/.test(comment.value));

  const program = shouldRun && getProgram(source, node);

  if (program) {
    return {
      flowDir,
      program
    };
  }

  return null;
}

function stopOnExit(context: EslintContext): boolean {
  return !!(
    context.settings &&
    context.settings['flowtype-errors'] &&
    context.settings['flowtype-errors'].stopOnExit
  );
}

function errorFlowCouldNotRun(loc) {
  return {
    loc,
    message: `Flow could not be run. Possible causes include:
  * Running on 32-bit OS (https://github.com/facebook/flow/issues/2262)
  * Recent glibc version not available (https://github.com/flowtype/flow-bin/issues/49)
  * FLOW_BIN environment variable ${
    process.env.FLOW_BIN ? 'set incorrectly' : 'not set'
  }
.`
  };
}

function createFilteredErrorRule(filter: CollectOutputElement => any) {
  return function showErrors(context: EslintContext) {
    return {
      Program(node: Object) {
        const source = context.getSourceCode();
        const info = lookupInfo(context, source, node);

        if (!info) {
          return;
        }

        const { flowDir, program } = info;

        const collected = collect(
          program.text,
          flowDir,
          stopOnExit(context),
          context.getFilename(),
          program.offset
        );

        if (collected === true) {
          return;
        }

        if (collected === false) {
          context.report(errorFlowCouldNotRun(program.loc));
          return;
        }

        collected.filter(filter).forEach(({ loc, message }) => {
          context.report({
            loc: loc
              ? {
                  ...loc,
                  start: {
                    ...loc.start,
                    // Flow's column numbers are 1-based, while ESLint's are 0-based.
                    column: loc.start.column - 1
                  }
                }
              : loc,
            message
          });
        });
      }
    };
  };
}

export default {
  rules: {
    'enforce-min-coverage': function enforceMinCoverage(
      context: EslintContext
    ) {
      return {
        Program(node: Object) {
          const source = context.getSourceCode();
          const info = lookupInfo(context, source, node);

          if (!info) {
            return;
          }

          const { flowDir, program } = info;

          const res = coverage(
            program.text,
            flowDir,
            stopOnExit(context),
            context.getFilename()
          );

          if (res === true) {
            return;
          }

          if (res === false) {
            context.report(errorFlowCouldNotRun(program.loc));
            return;
          }

          const requiredCoverage = context.options[0];
          const { coveredCount, uncoveredCount } = res;

          /* eslint prefer-template: 0 */
          const percentage = Number(
            Math.round(coveredCount / (coveredCount + uncoveredCount) * 10000) +
              'e-2'
          );

          if (percentage < requiredCoverage) {
            context.report({
              loc: program.loc,
              message: `Expected coverage to be at least ${requiredCoverage}%, but is: ${percentage}%`
            });
          }
        }
      };
    },
    'show-errors': createFilteredErrorRule(
      ({ level }) => level !== FlowSeverity.Warning
    ),
    'show-warnings': createFilteredErrorRule(
      ({ level }) => level === FlowSeverity.Warning
    )
  }
};
