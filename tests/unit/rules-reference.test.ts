// The rules reference (decision 85): rule messages in general words, in both languages.
import { describe, expect, it } from 'vitest';
import en from '../../src/i18n/en.json';
import fr from '../../src/i18n/fr.json';
import { generalMessage } from '../../src/lib/gate/messages';
import { RULE_SET_V1 } from '../../src/lib/gate/rules';

describe('generalMessage', () => {
  const words = { value: '[value]', field: '[field]', example: '[example]' };

  it('drops the row and shows each placeholder as a bracketed word', () => {
    expect(generalMessage('Row {row}: the ID "{value}" is missing or in the wrong format. Expected something like {example}.', words)).toBe(
      'The ID [value] is missing or in the wrong format. Expected something like [example].',
    );
    expect(generalMessage('Ligne {row} : {field} "{value}" n\'existe pas.', { value: '[valeur]', field: '[champ]' })).toBe("[champ] [valeur] n'existe pas.");
  });

  it('leaves a message with no placeholders as it is', () => {
    expect(generalMessage('This file type is not accepted.', words)).toBe('This file type is not accepted.');
  });

  it('shows an unknown placeholder as an ellipsis rather than as code', () => {
    expect(generalMessage('Row {row}: {mystery} is wrong.', words)).toBe('… is wrong.');
  });

  for (const [lang, catalogue] of [['en', en], ['fr', fr]] as const) {
    it(`every rule reads without placeholders in ${lang}`, () => {
      for (const rule of RULE_SET_V1.rules) {
        const text = generalMessage(lang === 'en' ? rule.messageEn : rule.messageFr, catalogue.rules_ref.words);
        expect(text, rule.id).not.toMatch(/[{}]|…/);
      }
    });
  }
});
