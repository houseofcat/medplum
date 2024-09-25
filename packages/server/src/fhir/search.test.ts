import {
  createReference,
  getReferenceString,
  LOINC,
  normalizeErrorString,
  normalizeOperationOutcome,
  OperationOutcomeError,
  Operator,
  parseSearchRequest,
  SearchRequest,
  SNOMED,
} from '@medplum/core';
import {
  ActivityDefinition,
  AllergyIntolerance,
  Appointment,
  AuditEvent,
  Binary,
  Bundle,
  BundleEntry,
  CareTeam,
  Coding,
  Communication,
  Condition,
  DiagnosticReport,
  Encounter,
  Goal,
  Location,
  MeasureReport,
  Observation,
  Organization,
  Patient,
  PlanDefinition,
  Practitioner,
  Project,
  Provenance,
  Questionnaire,
  QuestionnaireResponse,
  Resource,
  RiskAssessment,
  SearchParameter,
  ServiceRequest,
  StructureDefinition,
  Task,
} from '@medplum/fhirtypes';
import { randomUUID } from 'crypto';
import { initAppServices, shutdownApp } from '../app';
import { loadTestConfig, MedplumServerConfig } from '../config';
import { bundleContains, createTestProject, withTestContext } from '../test.setup';
import { getSystemRepo, Repository } from './repo';
import { clampEstimateCount } from './search';

jest.mock('hibp');

const SUBSET_TAG: Coding = { system: 'http://hl7.org/fhir/v3/ObservationValue', code: 'SUBSETTED' };

describe('FHIR Search', () => {
  describe('project-scoped Repository', () => {
    let config: MedplumServerConfig;
    let repo: Repository;

    beforeAll(async () => {
      config = await loadTestConfig();
      await initAppServices(config);
      const { project } = await createTestProject();
      repo = new Repository({
        strictMode: true,
        projects: [project.id as string],
        author: { reference: 'User/' + randomUUID() },
      });
    });

    afterAll(async () => {
      await shutdownApp();
    });

    test('Search total', async () =>
      withTestContext(async () => {
        await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice'], family: 'Smith' }],
        });
        await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Bob'], family: 'Smith' }],
        });
        const result1 = await repo.search({
          resourceType: 'Patient',
          count: 1,
        });
        expect(result1.total).toBeUndefined();
        expect(result1.link?.length).toBe(3);

        const result2 = await repo.search({
          resourceType: 'Patient',
          total: 'none',
        });
        expect(result2.total).toBeUndefined();

        const result3 = await repo.search({
          resourceType: 'Patient',
          total: 'accurate',
        });
        expect(result3.total).toBeDefined();
        expect(typeof result3.total).toBe('number');

        const result4 = await repo.search({
          resourceType: 'Patient',
          total: 'estimate',
        });
        expect(result4.total).toBeDefined();
        expect(typeof result4.total).toBe('number');
      }));

    test('Search count=0', async () =>
      withTestContext(async () => {
        const result1 = await repo.search({
          resourceType: 'Patient',
          count: 0,
        });
        expect(result1.entry).toBeUndefined();
        expect(result1.link).toBeDefined();
        expect(result1.link?.length).toBe(1);
      }));

    test('Search offset max', async () =>
      withTestContext(async () => {
        // Temporarily set a low maxSearchOffset
        const prevMax = config.maxSearchOffset;
        config.maxSearchOffset = 200;

        // Search under the limit, this should succeed
        const result1 = await repo.search({
          resourceType: 'Patient',
          offset: 100,
        });
        expect(result1.entry).toHaveLength(0);

        // Search over the limit, this should fail
        try {
          await repo.search({
            resourceType: 'Patient',
            offset: 300,
          });
          fail('Expected error');
        } catch (err) {
          expect(normalizeErrorString(err)).toEqual('Search offset exceeds maximum (got 300, max 200)');
        }

        // Restore the maxSearchOffset
        config.maxSearchOffset = prevMax;
      }));

    test('clampEstimateCount', () => {
      expect(clampEstimateCount({ resourceType: 'Patient' }, undefined, 0)).toEqual(0);
      expect(clampEstimateCount({ resourceType: 'Patient' }, 0, 0)).toEqual(0);

      // 0 actual rows, 10 estimated rows => we know count is 0
      expect(clampEstimateCount({ resourceType: 'Patient' }, 0, 10)).toEqual(0);

      // 10 actual rows, 0 estimated rows => we know count is at least 10
      expect(clampEstimateCount({ resourceType: 'Patient' }, 10, 0)).toEqual(10);

      // count = 20, offset = 0, rowCount = 10, estimate = 0 => 10 (estimate is too low)
      expect(clampEstimateCount({ resourceType: 'Patient' }, 10, 0)).toEqual(10);

      // count = 20, offset = 0, rowCount = 20, estimate = 20 => 20 (estimate accurate)
      expect(clampEstimateCount({ resourceType: 'Patient' }, 20, 20)).toEqual(20);

      // count = 20, offset = 0, rowCount = 21, estimate = 1000 => 1000 (estimate could be correct)
      expect(clampEstimateCount({ resourceType: 'Patient' }, 21, 1000)).toEqual(1000);

      // On page 2
      // count = 20, offset = 20, rowCount = 0, estimate = 20 => 20 (estimate is correct)
      expect(clampEstimateCount({ resourceType: 'Patient', offset: 20 }, 0, 20)).toEqual(20);

      // count = 20, offset = 20, rowCount = 0, estimate = 0 => 20 (estimate is too low, but rowCount is 0)
      expect(clampEstimateCount({ resourceType: 'Patient', offset: 20 }, 0, 0)).toEqual(0);

      // count = 20, offset = 20, rowCount = 1, estimate = 0 => 21 (estimate is too low)
      expect(clampEstimateCount({ resourceType: 'Patient', offset: 20 }, 1, 0)).toEqual(21);

      // count = 20, offset = 20, rowCount = 0, estimate = 200 => 20 (estimate is too high)
      expect(clampEstimateCount({ resourceType: 'Patient', offset: 20 }, 0, 200)).toEqual(20);

      // count = 20, offset = 20, rowCount = 1, estimate = 200 => 20 (estimate is too high)
      expect(clampEstimateCount({ resourceType: 'Patient', offset: 20 }, 1, 200)).toEqual(21);

      // count = 20, offset = 20, rowCount = 1, estimate = 200 => 20 (estimate is too high)
      expect(clampEstimateCount({ resourceType: 'Patient', offset: 20 }, 1, 200)).toEqual(21);

      // count = 20, offset = 20, rowCount = 21, estimate = 200 => 200 (estimate could be correct)
      expect(clampEstimateCount({ resourceType: 'Patient', offset: 20 }, 21, 200)).toEqual(200);
    });

    test('Search _summary', () =>
      withTestContext(async () => {
        const patient: Patient = {
          resourceType: 'Patient',
          meta: {
            profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
            tag: [{ system: 'http://example.com/', code: 'test' }],
          },
          text: {
            status: 'generated',
            div: '<div xmlns="http://www.w3.org/1999/xhtml"></div>',
          },
          identifier: [
            {
              use: 'usual',
              type: {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                    code: 'MR',
                    display: 'Medical Record Number',
                  },
                ],
                text: 'Medical Record Number',
              },
              system: 'http://hospital.smarthealthit.org',
              value: '1032702',
            },
          ],
          active: true,
          name: [
            {
              use: 'old',
              family: 'Shaw',
              given: ['Amy', 'V.'],
              period: {
                start: '2016-12-06',
                end: '2020-07-22',
              },
            },
            {
              family: 'Baxter',
              given: ['Amy', 'V.'],
              suffix: ['PharmD'],
              period: {
                start: '2020-07-22',
              },
            },
          ],
          telecom: [
            {
              system: 'phone',
              value: '555-555-5555',
              use: 'home',
            },
            {
              system: 'email',
              value: 'amy.shaw@example.com',
            },
          ],
          gender: 'female',
          birthDate: '1987-02-20',
          multipleBirthInteger: 2,
          address: [
            {
              use: 'old',
              line: ['49 Meadow St'],
              city: 'Mounds',
              state: 'OK',
              postalCode: '74047',
              country: 'US',
              period: {
                start: '2016-12-06',
                end: '2020-07-22',
              },
            },
            {
              line: ['183 Mountain View St'],
              city: 'Mounds',
              state: 'OK',
              postalCode: '74048',
              country: 'US',
              period: {
                start: '2020-07-22',
              },
            },
          ],
        };
        const resource = await repo.createResource(patient);

        // _summary=text
        const textResults = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: '_id', operator: Operator.EQUALS, value: resource.id as string }],
          summary: 'text',
        });
        expect(textResults.entry).toHaveLength(1);
        const textResult = textResults.entry?.[0]?.resource as Resource;
        expect(textResult).toEqual<Partial<Patient>>({
          resourceType: 'Patient',
          id: resource.id,
          meta: expect.objectContaining({
            profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
            tag: [{ system: 'http://example.com/', code: 'test' }, SUBSET_TAG],
          }),
          text: {
            status: 'generated',
            div: '<div xmlns="http://www.w3.org/1999/xhtml"></div>',
          },
        });

        // _summary=data
        const dataResults = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: '_id', operator: Operator.EQUALS, value: resource.id as string }],
          summary: 'data',
        });
        expect(dataResults.entry).toHaveLength(1);
        const dataResult = dataResults.entry?.[0]?.resource as Resource;
        const { text: _1, ...dataExpected } = resource;
        dataExpected.meta?.tag?.push(SUBSET_TAG);
        expect(dataResult).toEqual<Partial<Patient>>({ ...dataExpected });

        // _summary=true
        const summaryResults = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: '_id', operator: Operator.EQUALS, value: resource.id as string }],
          summary: 'true',
        });
        expect(summaryResults.entry).toHaveLength(1);
        const summaryResult = summaryResults.entry?.[0]?.resource as Resource;
        const { multipleBirthInteger: _2, text: _3, ...summaryResource } = resource;
        expect(summaryResult).toEqual<Partial<Patient>>(summaryResource);
      }));

    test('Search _elements', () =>
      withTestContext(async () => {
        const patient: Patient = {
          resourceType: 'Patient',
          birthDate: '2000-01-01',
          _birthDate: {
            extension: [
              {
                url: 'http://hl7.org/fhir/StructureDefinition/patient-birthTime',
                valueDateTime: '2000-01-01T00:00:00.001Z',
              },
            ],
          },
          multipleBirthInteger: 2,
          deceasedBoolean: false,
        } as unknown as Patient;
        const resource = await repo.createResource(patient);

        const results = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: '_id', operator: Operator.EQUALS, value: resource.id as string }],
          fields: ['birthDate', 'deceased'],
        });
        expect(results.entry).toHaveLength(1);
        const result = results.entry?.[0]?.resource as Resource;
        expect(result).toEqual<Partial<Patient>>({
          resourceType: 'Patient',
          id: resource.id,
          meta: expect.objectContaining({
            tag: [SUBSET_TAG],
          }),
          birthDate: resource.birthDate,
          _birthDate: (resource as any)._birthDate,
          deceasedBoolean: resource.deceasedBoolean,
        } as unknown as Patient);
      }));

    test('Search next link', () =>
      withTestContext(async () => {
        const family = randomUUID();

        for (let i = 0; i < 2; i++) {
          await repo.createResource({
            resourceType: 'Patient',
            name: [{ family }],
          });
        }

        const result1 = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: 'name', operator: Operator.EQUALS, value: family }],
          count: 1,
        });
        expect(result1.entry).toHaveLength(1);
        expect(result1.link).toBeDefined();
        expect(result1.link?.find((e) => e.relation === 'next')).toBeDefined();

        const result2 = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: 'name', operator: Operator.EQUALS, value: family }],
          count: 2,
        });
        expect(result2.entry).toHaveLength(2);
        expect(result2.link).toBeDefined();
        expect(result2.link?.find((e) => e.relation === 'next')).toBeUndefined();

        const result3 = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: 'name', operator: Operator.EQUALS, value: family }],
          count: 3,
        });
        expect(result3.entry).toHaveLength(2);
        expect(result3.link).toBeDefined();
        expect(result3.link?.find((e) => e.relation === 'next')).toBeUndefined();
      }));

    test('Search previous link', () =>
      withTestContext(async () => {
        const family = randomUUID();

        for (let i = 0; i < 2; i++) {
          await repo.createResource({
            resourceType: 'Patient',
            name: [{ family }],
          });
        }

        const result1 = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: 'name', operator: Operator.EQUALS, value: family }],
          count: 1,
          offset: 1,
        });
        expect(result1.entry).toHaveLength(1);
        expect(result1.link).toBeDefined();
        expect(result1.link?.find((e) => e.relation === 'previous')).toBeDefined();
      }));

    test('Search for Communications by Encounter', () =>
      withTestContext(async () => {
        const patient1 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice'], family: 'Smith' }],
        });

        expect(patient1).toBeDefined();

        const encounter1 = await repo.createResource<Encounter>({
          resourceType: 'Encounter',
          status: 'in-progress',
          class: {
            code: 'HH',
            display: 'home health',
          },
          subject: createReference(patient1 as Patient),
        });

        expect(encounter1).toBeDefined();

        const comm1 = await repo.createResource<Communication>({
          resourceType: 'Communication',
          status: 'completed',
          encounter: createReference(encounter1 as Encounter),
          subject: createReference(patient1 as Patient),
          sender: createReference(patient1 as Patient),
          payload: [{ contentString: 'This is a test' }],
        });

        expect(comm1).toBeDefined();

        const patient2 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Bob'], family: 'Jones' }],
        });

        expect(patient2).toBeDefined();

        const encounter2 = await repo.createResource<Encounter>({
          resourceType: 'Encounter',
          status: 'in-progress',
          class: {
            code: 'HH',
            display: 'home health',
          },
          subject: createReference(patient2 as Patient),
        });

        expect(encounter2).toBeDefined();

        const comm2 = await repo.createResource<Communication>({
          resourceType: 'Communication',
          status: 'completed',
          encounter: createReference(encounter2 as Encounter),
          subject: createReference(patient2 as Patient),
          sender: createReference(patient2 as Patient),
          payload: [{ contentString: 'This is another test' }],
        });

        expect(comm2).toBeDefined();

        const searchResult = await repo.search({
          resourceType: 'Communication',
          filters: [
            {
              code: 'encounter',
              operator: Operator.EQUALS,
              value: getReferenceString(encounter1 as Encounter),
            },
          ],
        });

        expect(searchResult.entry?.length).toEqual(1);
        expect(searchResult.entry?.[0]?.resource?.id).toEqual(comm1.id);
      }));

    test('Search for Communications by ServiceRequest', () =>
      withTestContext(async () => {
        const patient1 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice'], family: 'Smith' }],
        });

        expect(patient1).toBeDefined();

        const serviceRequest1 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          code: {
            text: 'text',
          },
          subject: createReference(patient1 as Patient),
        });

        expect(serviceRequest1).toBeDefined();

        const comm1 = await repo.createResource<Communication>({
          resourceType: 'Communication',
          status: 'completed',
          basedOn: [createReference(serviceRequest1 as ServiceRequest)],
          subject: createReference(patient1 as Patient),
          sender: createReference(patient1 as Patient),
          payload: [{ contentString: 'This is a test' }],
        });

        expect(comm1).toBeDefined();

        const patient2 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Bob'], family: 'Jones' }],
        });

        expect(patient2).toBeDefined();

        const serviceRequest2 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          code: {
            text: 'test',
          },
          subject: createReference(patient2 as Patient),
        });

        expect(serviceRequest2).toBeDefined();

        const comm2 = await repo.createResource<Communication>({
          resourceType: 'Communication',
          status: 'completed',
          basedOn: [createReference(serviceRequest2 as ServiceRequest)],
          subject: createReference(patient2 as Patient),
          sender: createReference(patient2 as Patient),
          payload: [{ contentString: 'This is another test' }],
        });

        expect(comm2).toBeDefined();

        const searchResult = await repo.search({
          resourceType: 'Communication',
          filters: [
            {
              code: 'based-on',
              operator: Operator.EQUALS,
              value: getReferenceString(serviceRequest1 as ServiceRequest),
            },
          ],
        });

        expect(searchResult.entry?.length).toEqual(1);
        expect(searchResult.entry?.[0]?.resource?.id).toEqual(comm1.id);
      }));

    test('Search for QuestionnaireResponse by Questionnaire', () =>
      withTestContext(async () => {
        const questionnaire = await repo.createResource<Questionnaire>({
          resourceType: 'Questionnaire',
          status: 'active',
        });

        const response1 = await repo.createResource<QuestionnaireResponse>({
          resourceType: 'QuestionnaireResponse',
          status: 'completed',
          questionnaire: getReferenceString(questionnaire),
        });

        await repo.createResource<QuestionnaireResponse>({
          resourceType: 'QuestionnaireResponse',
          status: 'completed',
          questionnaire: `Questionnaire/${randomUUID()}`,
        });

        const bundle = await repo.search({
          resourceType: 'QuestionnaireResponse',
          filters: [
            {
              code: 'questionnaire',
              operator: Operator.EQUALS,
              value: getReferenceString(questionnaire),
            },
          ],
        });
        expect(bundle.entry?.length).toEqual(1);
        expect(bundle.entry?.[0]?.resource?.id).toEqual(response1.id);
      }));

    test('Search for token in array', async () =>
      withTestContext(async () => {
        const bundle = await repo.search({
          resourceType: 'SearchParameter',
          filters: [
            {
              code: 'base',
              operator: Operator.EQUALS,
              value: 'Patient',
            },
          ],
          count: 100,
        });

        expect(bundle.entry?.find((e) => (e.resource as SearchParameter).code === 'name')).toBeDefined();
        expect(bundle.entry?.find((e) => (e.resource as SearchParameter).code === 'email')).toBeDefined();
      }));

    test('Search sort by Patient.id', async () =>
      withTestContext(async () => {
        const bundle = await repo.search({
          resourceType: 'Patient',
          sortRules: [{ code: '_id' }],
        });

        expect(bundle).toBeDefined();
      }));

    test('Search sort by Patient.meta.lastUpdated', async () =>
      withTestContext(async () => {
        const bundle = await repo.search({
          resourceType: 'Patient',
          sortRules: [{ code: '_lastUpdated' }],
        });

        expect(bundle).toBeDefined();
      }));

    test('Search sort by Patient.identifier', async () =>
      withTestContext(async () => {
        const bundle = await repo.search({
          resourceType: 'Patient',
          sortRules: [{ code: 'identifier' }],
        });

        expect(bundle).toBeDefined();
      }));

    test('Search sort by Patient.name', async () =>
      withTestContext(async () => {
        const bundle = await repo.search({
          resourceType: 'Patient',
          sortRules: [{ code: 'name' }],
        });

        expect(bundle).toBeDefined();
      }));

    test('Search sort by Patient.given', async () =>
      withTestContext(async () => {
        const bundle = await repo.search({
          resourceType: 'Patient',
          sortRules: [{ code: 'given' }],
        });

        expect(bundle).toBeDefined();
      }));

    test('Search sort by Patient.address', async () =>
      withTestContext(async () => {
        const bundle = await repo.search({
          resourceType: 'Patient',
          sortRules: [{ code: 'address' }],
        });

        expect(bundle).toBeDefined();
      }));

    test('Search sort by Patient.telecom', async () =>
      withTestContext(async () => {
        const bundle = await repo.search({
          resourceType: 'Patient',
          sortRules: [{ code: 'telecom' }],
        });

        expect(bundle).toBeDefined();
      }));

    test('Search sort by Patient.email', async () =>
      withTestContext(async () => {
        const bundle = await repo.search({
          resourceType: 'Patient',
          sortRules: [{ code: 'email' }],
        });

        expect(bundle).toBeDefined();
      }));

    test('Search sort by Patient.birthDate', async () =>
      withTestContext(async () => {
        const bundle = await repo.search({
          resourceType: 'Patient',
          sortRules: [{ code: 'birthdate' }],
        });

        expect(bundle).toBeDefined();
      }));

    test('Filter and sort on same search parameter', () =>
      withTestContext(async () => {
        await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Marge'], family: 'Simpson' }],
        });

        await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Homer'], family: 'Simpson' }],
        });

        const bundle = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: 'family', operator: Operator.EQUALS, value: 'Simpson' }],
          sortRules: [{ code: 'family' }],
        });

        expect(bundle.entry).toBeDefined();
        expect(bundle.entry?.length).toBeGreaterThanOrEqual(2);
      }));

    test('Search birthDate after delete', () =>
      withTestContext(async () => {
        const family = randomUUID();

        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice'], family }],
          birthDate: '1971-02-02',
        });

        const searchResult1 = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'family',
              operator: Operator.EQUALS,
              value: family,
            },
            {
              code: 'birthdate',
              operator: Operator.EQUALS,
              value: '1971-02-02',
            },
          ],
        });

        expect(searchResult1.entry?.length).toEqual(1);
        expect(searchResult1.entry?.[0]?.resource?.id).toEqual(patient.id);

        await repo.deleteResource('Patient', patient.id as string);

        const searchResult2 = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'family',
              operator: Operator.EQUALS,
              value: family,
            },
            {
              code: 'birthdate',
              operator: Operator.EQUALS,
              value: '1971-02-02',
            },
          ],
        });

        expect(searchResult2.entry?.length).toEqual(0);
      }));

    test('Search identifier after delete', () =>
      withTestContext(async () => {
        const identifier = randomUUID();

        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice'], family: 'Smith' }],
          identifier: [{ system: 'https://www.example.com', value: identifier }],
        });

        const searchResult1 = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'identifier',
              operator: Operator.EQUALS,
              value: identifier,
            },
          ],
        });

        expect(searchResult1.entry?.length).toEqual(1);
        expect(searchResult1.entry?.[0]?.resource?.id).toEqual(patient.id);

        await repo.deleteResource('Patient', patient.id as string);

        const searchResult2 = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'identifier',
              operator: Operator.EQUALS,
              value: identifier,
            },
          ],
        });

        expect(searchResult2.entry?.length).toEqual(0);
      }));

    test('String filter', async () =>
      withTestContext(async () => {
        const bundle1 = await repo.search<StructureDefinition>({
          resourceType: 'StructureDefinition',
          filters: [
            {
              code: 'name',
              operator: Operator.EQUALS,
              value: 'Questionnaire',
            },
          ],
          sortRules: [
            {
              code: 'name',
              descending: false,
            },
          ],
        });
        expect(bundle1.entry?.map((e) => e.resource?.name)).toEqual(['Questionnaire', 'QuestionnaireResponse']);

        const bundle2 = await repo.search({
          resourceType: 'StructureDefinition',
          filters: [
            {
              code: 'name',
              operator: Operator.EXACT,
              value: 'Questionnaire',
            },
          ],
        });
        expect(bundle2.entry?.length).toEqual(1);
        expect((bundle2.entry?.[0]?.resource as StructureDefinition).name).toEqual('Questionnaire');
      }));

    test('String filter with escaped commas', async () =>
      withTestContext(async () => {
        // Create a name with commas
        const name = randomUUID().replaceAll('-', ',');

        const location = await repo.createResource<Location>({
          resourceType: 'Location',
          name,
        });

        const bundle = await repo.search<Location>({
          resourceType: 'Location',
          filters: [
            {
              code: 'name',
              operator: Operator.EXACT,
              value: name.replaceAll(',', '\\,'),
            },
          ],
        });
        expect(bundle.entry?.length).toEqual(1);
        expect(bundleContains(bundle, location)).toBeDefined();
      }));

    test('Filter by _id', () =>
      withTestContext(async () => {
        // Unique family name to isolate the test
        const family = randomUUID();

        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice'], family }],
        });
        expect(patient).toBeDefined();

        const searchResult1 = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: '_id',
              operator: Operator.EQUALS,
              value: patient.id as string,
            },
          ],
        });

        expect(searchResult1.entry?.length).toEqual(1);
        expect(bundleContains(searchResult1 as Bundle, patient as Patient)).toBeDefined();

        const searchResult2 = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'name',
              operator: Operator.EQUALS,
              value: family,
            },
            {
              code: '_id',
              operator: Operator.NOT_EQUALS,
              value: patient.id as string,
            },
          ],
        });

        expect(searchResult2.entry?.length).toEqual(0);
      }));

    test('Empty _id', async () =>
      withTestContext(async () => {
        const searchResult1 = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: '_id',
              operator: Operator.EQUALS,
              value: '',
            },
          ],
        });

        expect(searchResult1.entry?.length).toEqual(0);
      }));

    test('Non UUID _id', async () =>
      withTestContext(async () => {
        const searchResult1 = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: '_id',
              operator: Operator.EQUALS,
              value: 'x',
            },
          ],
        });

        expect(searchResult1.entry?.length).toEqual(0);
      }));

    test('Non UUID _compartment', async () =>
      withTestContext(async () => {
        const searchResult1 = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: '_compartment',
              operator: Operator.EQUALS,
              value: 'x',
            },
          ],
        });

        expect(searchResult1.entry?.length).toEqual(0);
      }));

    test('Reference string _compartment', () =>
      withTestContext(async () => {
        const patient = await repo.createResource<Patient>({ resourceType: 'Patient' });

        const searchResult1 = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: '_compartment',
              operator: Operator.EQUALS,
              value: getReferenceString(patient),
            },
          ],
        });

        expect(searchResult1.entry?.length).toEqual(1);
        expect(bundleContains(searchResult1 as Bundle, patient as Patient)).toBeDefined();
      }));

    test('Handle malformed _lastUpdated', async () =>
      withTestContext(async () => {
        try {
          await repo.search({
            resourceType: 'Patient',
            filters: [
              {
                code: '_lastUpdated',
                operator: Operator.GREATER_THAN,
                value: 'xyz',
              },
            ],
          });
          fail('Expected error');
        } catch (err) {
          expect(normalizeErrorString(err)).toEqual('Invalid date value: xyz');
        }
      }));

    test('Filter by Coding', () =>
      withTestContext(async () => {
        const auditEvents = [] as AuditEvent[];

        for (let i = 0; i < 3; i++) {
          const resource = await repo.createResource<AuditEvent>({
            resourceType: 'AuditEvent',
            recorded: new Date().toISOString(),
            type: {
              code: randomUUID(),
            },
            agent: [
              {
                who: { reference: 'Practitioner/' + randomUUID() },
                requestor: true,
              },
            ],
            source: {
              observer: { reference: 'Practitioner/' + randomUUID() },
            },
          });
          auditEvents.push(resource);
        }

        for (let i = 0; i < 3; i++) {
          const bundle = await repo.search({
            resourceType: 'AuditEvent',
            filters: [
              {
                code: 'type',
                operator: Operator.CONTAINS,
                value: auditEvents[i].type?.code as string,
              },
            ],
          });
          expect(bundle.entry?.length).toEqual(1);
          expect(bundle.entry?.[0]?.resource?.id).toEqual(auditEvents[i].id);
        }
      }));

    test('Filter by CodeableConcept', () =>
      withTestContext(async () => {
        const x1 = randomUUID();
        const x2 = randomUUID();
        const x3 = randomUUID();

        // Create test patient
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['John'], family: 'CodeableConcept' }],
        });

        const serviceRequest1 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: createReference(patient),
          code: { coding: [{ code: x1 }] },
        });

        const serviceRequest2 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: createReference(patient),
          code: { coding: [{ code: x2 }] },
        });

        const serviceRequest3 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: createReference(patient),
          code: { coding: [{ code: x3 }] },
        });

        const bundle1 = await repo.search({
          resourceType: 'ServiceRequest',
          filters: [
            {
              code: 'code',
              operator: Operator.EQUALS,
              value: x1,
            },
          ],
        });
        expect(bundle1.entry?.length).toEqual(1);
        expect(bundleContains(bundle1, serviceRequest1)).toBeDefined();
        expect(bundleContains(bundle1, serviceRequest2)).toBeUndefined();
        expect(bundleContains(bundle1, serviceRequest3)).toBeUndefined();

        const bundle2 = await repo.search({
          resourceType: 'ServiceRequest',
          filters: [
            {
              code: 'code',
              operator: Operator.EQUALS,
              value: x2,
            },
          ],
        });
        expect(bundle2.entry?.length).toEqual(1);
        expect(bundleContains(bundle2, serviceRequest1)).toBeUndefined();
        expect(bundleContains(bundle2, serviceRequest2)).toBeDefined();
        expect(bundleContains(bundle2, serviceRequest3)).toBeUndefined();

        const bundle3 = await repo.search({
          resourceType: 'ServiceRequest',
          filters: [
            {
              code: 'code',
              operator: Operator.EQUALS,
              value: x3,
            },
          ],
        });
        expect(bundle3.entry?.length).toEqual(1);
        expect(bundleContains(bundle3, serviceRequest1)).toBeUndefined();
        expect(bundleContains(bundle3, serviceRequest2)).toBeUndefined();
        expect(bundleContains(bundle3, serviceRequest3)).toBeDefined();
      }));

    test('Filter by Quantity.value', () =>
      withTestContext(async () => {
        const code = randomUUID();

        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['John'], family: 'Quantity' }],
        });

        const observation1 = await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          subject: createReference(patient),
          code: { coding: [{ code }] },
          valueQuantity: { value: 1, unit: 'mg' },
        });

        const observation2 = await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          subject: createReference(patient),
          code: { coding: [{ code }] },
          valueQuantity: { value: 5, unit: 'mg' },
        });

        const observation3 = await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          subject: createReference(patient),
          code: { coding: [{ code }] },
          valueQuantity: { value: 10, unit: 'mg' },
        });

        const bundle1 = await repo.search<Observation>({
          resourceType: 'Observation',
          filters: [{ code: 'code', operator: Operator.EQUALS, value: code }],
          sortRules: [{ code: 'value-quantity', descending: false }],
        });
        expect(bundle1.entry?.length).toEqual(3);
        expect(bundle1.entry?.[0]?.resource?.id).toEqual(observation1.id);
        expect(bundle1.entry?.[1]?.resource?.id).toEqual(observation2.id);
        expect(bundle1.entry?.[2]?.resource?.id).toEqual(observation3.id);

        const bundle2 = await repo.search<Observation>({
          resourceType: 'Observation',
          filters: [{ code: 'code', operator: Operator.EQUALS, value: code }],
          sortRules: [{ code: 'value-quantity', descending: true }],
        });
        expect(bundle2.entry?.length).toEqual(3);
        expect(bundle2.entry?.[0]?.resource?.id).toEqual(observation3.id);
        expect(bundle2.entry?.[1]?.resource?.id).toEqual(observation2.id);
        expect(bundle2.entry?.[2]?.resource?.id).toEqual(observation1.id);

        const bundle3 = await repo.search<Observation>({
          resourceType: 'Observation',
          filters: [
            { code: 'code', operator: Operator.EQUALS, value: code },
            { code: 'value-quantity', operator: Operator.GREATER_THAN, value: '8' },
          ],
        });
        expect(bundle3.entry?.length).toEqual(1);
        expect(bundle3.entry?.[0]?.resource?.id).toEqual(observation3.id);
      }));

    test('ServiceRequest.orderDetail search', () =>
      withTestContext(async () => {
        const orderDetailText = randomUUID();
        const orderDetailCode = randomUUID();

        const serviceRequest = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: {
            reference: 'Patient/' + randomUUID(),
          },
          code: {
            coding: [
              {
                code: 'order-type',
              },
            ],
          },
          orderDetail: [
            {
              text: orderDetailText,
              coding: [
                {
                  system: 'custom-order-system',
                  code: orderDetailCode,
                },
              ],
            },
          ],
        });

        const bundle1 = await repo.search({
          resourceType: 'ServiceRequest',
          filters: [
            {
              code: 'order-detail',
              operator: Operator.CONTAINS,
              value: orderDetailText,
            },
          ],
        });
        expect(bundle1.entry?.length).toEqual(1);
        expect(bundle1.entry?.[0]?.resource?.id).toEqual(serviceRequest.id);
      }));

    test('Comma separated value', () =>
      withTestContext(async () => {
        const category = randomUUID();
        const codes = [randomUUID(), randomUUID(), randomUUID()];
        const serviceRequests = [];

        for (const code of codes) {
          const serviceRequest = await repo.createResource<ServiceRequest>({
            resourceType: 'ServiceRequest',
            status: 'active',
            intent: 'order',
            subject: { reference: 'Patient/' + randomUUID() },
            category: [{ coding: [{ code: category }] }],
            code: { coding: [{ code: code }] },
          });
          serviceRequests.push(serviceRequest);
        }

        const bundle1 = await repo.search(
          parseSearchRequest('ServiceRequest', { category, code: `${codes[0]},${codes[1]}` })
        );
        expect(bundle1.entry?.length).toEqual(2);
        expect(bundleContains(bundle1, serviceRequests[0])).toBeDefined();
        expect(bundleContains(bundle1, serviceRequests[1])).toBeDefined();
      }));

    test('Token not equals', () =>
      withTestContext(async () => {
        const category = randomUUID();
        const code1 = randomUUID();
        const code2 = randomUUID();

        const serviceRequest1 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: { reference: 'Patient/' + randomUUID() },
          category: [{ coding: [{ code: category }] }],
          code: { coding: [{ code: code1 }] },
        });

        const serviceRequest2 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: { reference: 'Patient/' + randomUUID() },
          category: [{ coding: [{ code: category }] }],
          code: { coding: [{ code: code2 }] },
        });

        const bundle1 = await repo.search(parseSearchRequest('ServiceRequest', { category, 'code:not': code1 }));
        expect(bundle1.entry?.length).toEqual(1);
        expect(bundleContains(bundle1, serviceRequest1)).toBeUndefined();
        expect(bundleContains(bundle1, serviceRequest2)).toBeDefined();
      }));

    test('Token array not equals', () =>
      withTestContext(async () => {
        const category1 = randomUUID();
        const category2 = randomUUID();
        const code = randomUUID();

        const serviceRequest1 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: { reference: 'Patient/' + randomUUID() },
          category: [{ coding: [{ code: category1 }] }],
          code: { coding: [{ code }] },
        });

        const serviceRequest2 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: { reference: 'Patient/' + randomUUID() },
          category: [{ coding: [{ code: category2 }] }],
          code: { coding: [{ code }] },
        });

        const bundle1 = await repo.search(parseSearchRequest('ServiceRequest', { code, 'category:not': category1 }));
        expect(bundle1.entry?.length).toEqual(1);
        expect(bundleContains(bundle1, serviceRequest1)).toBeUndefined();
        expect(bundleContains(bundle1, serviceRequest2)).toBeDefined();
      }));

    test('Null token array not equals', () =>
      withTestContext(async () => {
        const category1 = randomUUID();
        const code = randomUUID();

        const serviceRequest1 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: { reference: 'Patient/' + randomUUID() },
          category: [{ coding: [{ code: category1 }] }],
          code: { coding: [{ code }] },
        });

        const serviceRequest2 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: { reference: 'Patient/' + randomUUID() },
          code: { coding: [{ code }] },
        });

        const bundle1 = await repo.search(parseSearchRequest('ServiceRequest', { code, 'category:not': category1 }));
        expect(bundle1.entry?.length).toEqual(1);
        expect(bundleContains(bundle1, serviceRequest1)).toBeUndefined();
        expect(bundleContains(bundle1, serviceRequest2)).toBeDefined();
      }));

    test('Missing', () =>
      withTestContext(async () => {
        const code = randomUUID();

        // Test both an array column (specimen) and a non-array column (encounter),
        // because the resulting SQL could be subtly different.

        const serviceRequest1 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          code: { coding: [{ code }] },
          subject: { reference: 'Patient/' + randomUUID() },
          specimen: [{ reference: 'Specimen/' + randomUUID() }],
          encounter: { reference: 'Encounter/' + randomUUID() },
        });

        const serviceRequest2 = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          code: { coding: [{ code }] },
          subject: { reference: 'Patient/' + randomUUID() },
        });

        const bundle1 = await repo.search(parseSearchRequest('ServiceRequest', { code, 'specimen:missing': 'true' }));
        expect(bundle1.entry?.length).toEqual(1);
        expect(bundleContains(bundle1, serviceRequest1)).toBeUndefined();
        expect(bundleContains(bundle1, serviceRequest2)).toBeDefined();

        const bundle2 = await repo.search(parseSearchRequest('ServiceRequest', { code, 'specimen:missing': 'false' }));
        expect(bundle2.entry?.length).toEqual(1);
        expect(bundleContains(bundle2, serviceRequest1)).toBeDefined();
        expect(bundleContains(bundle2, serviceRequest2)).toBeUndefined();

        const bundle3 = await repo.search(parseSearchRequest('ServiceRequest', { code, 'encounter:missing': 'true' }));
        expect(bundle3.entry?.length).toEqual(1);
        expect(bundleContains(bundle3, serviceRequest1)).toBeUndefined();
        expect(bundleContains(bundle3, serviceRequest2)).toBeDefined();

        const bundle4 = await repo.search(parseSearchRequest('ServiceRequest', { code, 'encounter:missing': 'false' }));
        expect(bundle4.entry?.length).toEqual(1);
        expect(bundleContains(bundle4, serviceRequest1)).toBeDefined();
        expect(bundleContains(bundle4, serviceRequest2)).toBeUndefined();
      }));

    test('Missing with logical (identifier) references', () =>
      withTestContext(async () => {
        const patientIdentifier = randomUUID();
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          identifier: [
            {
              system: 'http://example.com/guid',
              value: patientIdentifier,
            },
          ],
          generalPractitioner: [
            {
              identifier: {
                system: 'http://hl7.org/fhir/sid/us-npi',
                value: '9876543210',
              },
            },
          ],
          managingOrganization: {
            identifier: {
              system: 'http://hl7.org/fhir/sid/us-npi',
              value: '0123456789',
            },
          },
        });

        // Test singlet reference column
        let results = await repo.searchResources(
          parseSearchRequest(`Patient?identifier=${patientIdentifier}&organization:missing=false`)
        );
        expect(results).toHaveLength(1);
        expect(results[0]?.id).toEqual(patient.id);

        // Test array reference column
        results = await repo.searchResources(
          parseSearchRequest(`Patient?identifier=${patientIdentifier}&general-practitioner:missing=false`)
        );
        expect(results).toHaveLength(1);
        expect(results[0]?.id).toEqual(patient.id);
      }));

    test('Starts after', () =>
      withTestContext(async () => {
        // Create 2 appointments
        // One with a start date of 1 second ago
        // One with a start date of 2 seconds ago
        const code = randomUUID();
        const now = new Date();
        const nowMinus1Second = new Date(now.getTime() - 1000);
        const nowMinus2Seconds = new Date(now.getTime() - 2000);
        const nowMinus3Seconds = new Date(now.getTime() - 3000);
        const patient: Patient = { resourceType: 'Patient' };
        const patientReference = createReference(patient);
        const appt1 = await repo.createResource<Appointment>({
          resourceType: 'Appointment',
          status: 'booked',
          serviceType: [{ coding: [{ code }] }],
          participant: [{ status: 'accepted', actor: patientReference }],
          start: nowMinus1Second.toISOString(),
          end: now.toISOString(),
        });
        expect(appt1).toBeDefined();

        const appt2 = await repo.createResource<Appointment>({
          resourceType: 'Appointment',
          status: 'booked',
          serviceType: [{ coding: [{ code }] }],
          participant: [{ status: 'accepted', actor: patientReference }],
          start: nowMinus2Seconds.toISOString(),
          end: now.toISOString(),
        });
        expect(appt2).toBeDefined();

        // Greater than (newer than) 2 seconds ago should only return appt 1
        const searchResult1 = await repo.search({
          resourceType: 'Appointment',
          filters: [
            {
              code: 'service-type',
              operator: Operator.EQUALS,
              value: code,
            },
            {
              code: 'date',
              operator: Operator.STARTS_AFTER,
              value: nowMinus2Seconds.toISOString(),
            },
          ],
        });

        expect(bundleContains(searchResult1 as Bundle, appt1 as Appointment)).toBeDefined();
        expect(bundleContains(searchResult1 as Bundle, appt2 as Appointment)).toBeUndefined();

        // Greater than (newer than) or equal to 2 seconds ago should return both appts
        const searchResult2 = await repo.search({
          resourceType: 'Appointment',
          filters: [
            {
              code: 'service-type',
              operator: Operator.EQUALS,
              value: code,
            },
            {
              code: 'date',
              operator: Operator.GREATER_THAN_OR_EQUALS,
              value: nowMinus2Seconds.toISOString(),
            },
          ],
        });

        expect(bundleContains(searchResult2 as Bundle, appt1 as Appointment)).toBeDefined();
        expect(bundleContains(searchResult2 as Bundle, appt2 as Appointment)).toBeDefined();

        // Less than (older than) to 1 seconds ago should only return appt 2
        const searchResult3 = await repo.search({
          resourceType: 'Appointment',
          filters: [
            {
              code: 'service-type',
              operator: Operator.EQUALS,
              value: code,
            },
            {
              code: 'date',
              operator: Operator.STARTS_AFTER,
              value: nowMinus3Seconds.toISOString(),
            },
            {
              code: 'date',
              operator: Operator.ENDS_BEFORE,
              value: nowMinus1Second.toISOString(),
            },
          ],
        });

        expect(bundleContains(searchResult3 as Bundle, appt1 as Appointment)).toBeUndefined();
        expect(bundleContains(searchResult3 as Bundle, appt2 as Appointment)).toBeDefined();

        // Less than (older than) or equal to 1 seconds ago should return both appts
        const searchResult4 = await repo.search({
          resourceType: 'Appointment',
          filters: [
            {
              code: 'service-type',
              operator: Operator.EQUALS,
              value: code,
            },
            {
              code: 'date',
              operator: Operator.STARTS_AFTER,
              value: nowMinus3Seconds.toISOString(),
            },
            {
              code: 'date',
              operator: Operator.LESS_THAN_OR_EQUALS,
              value: nowMinus1Second.toISOString(),
            },
          ],
        });

        expect(bundleContains(searchResult4 as Bundle, appt1 as Appointment)).toBeDefined();
        expect(bundleContains(searchResult4 as Bundle, appt2 as Appointment)).toBeDefined();
      }));

    test('Boolean search', () =>
      withTestContext(async () => {
        const family = randomUUID();
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ family }],
          active: true,
        });
        const searchResult = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'name',
              operator: Operator.EQUALS,
              value: family,
            },
            {
              code: 'active',
              operator: Operator.EQUALS,
              value: 'true',
            },
          ],
        });
        expect(searchResult.entry).toHaveLength(1);
        expect(searchResult.entry?.[0]?.resource?.id).toEqual(patient.id);
      }));

    test('Not equals with comma separated values', () =>
      withTestContext(async () => {
        // Create 3 service requests
        // All 3 have the same category for test isolation
        // Each have a different code
        const category = randomUUID();
        const serviceRequests = [];
        for (let i = 0; i < 3; i++) {
          serviceRequests.push(
            await repo.createResource({
              resourceType: 'ServiceRequest',
              status: 'active',
              intent: 'order',
              subject: { reference: 'Patient/' + randomUUID() },
              category: [{ coding: [{ code: category }] }],
              code: { coding: [{ code: randomUUID() }] },
            })
          );
        }

        // Search for service requests with category
        // and code "not equals" the first two separated by a comma
        const searchResult = await repo.search({
          resourceType: 'ServiceRequest',
          filters: [
            {
              code: 'category',
              operator: Operator.EQUALS,
              value: category,
            },
            {
              code: 'code',
              operator: Operator.NOT_EQUALS,
              value: serviceRequests[0].code.coding[0].code + ',' + serviceRequests[1].code.coding[0].code,
            },
          ],
        });
        expect(searchResult.entry).toHaveLength(1);
      }));

    test('_id equals with comma separated values', () =>
      withTestContext(async () => {
        // Create 3 service requests
        const serviceRequests = [];
        for (let i = 0; i < 3; i++) {
          serviceRequests.push(
            await repo.createResource<ServiceRequest>({
              resourceType: 'ServiceRequest',
              status: 'active',
              intent: 'order',
              subject: { reference: 'Patient/' + randomUUID() },
              code: { text: randomUUID() },
            })
          );
        }

        // Search for service requests with _id equals the first two separated by a comma
        const searchResult = await repo.search({
          resourceType: 'ServiceRequest',
          filters: [
            {
              code: '_id',
              operator: Operator.EQUALS,
              value: serviceRequests[0].id + ',' + serviceRequests[1].id,
            },
          ],
        });
        expect(searchResult.entry).toHaveLength(2);
      }));

    test('Error on invalid search parameter', async () =>
      withTestContext(async () => {
        try {
          await repo.search({
            resourceType: 'ServiceRequest',
            filters: [
              {
                code: 'basedOn', // should be "based-on"
                operator: Operator.EQUALS,
                value: 'ServiceRequest/123',
              },
            ],
          });
        } catch (err) {
          const outcome = (err as OperationOutcomeError).outcome;
          expect(outcome.issue?.[0]?.details?.text).toEqual('Unknown search parameter: basedOn');
        }
      }));

    test('Patient search without resource type', () =>
      withTestContext(async () => {
        // Create Patient
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
        });

        // Create AllergyIntolerance
        const allergyIntolerance = await repo.createResource<AllergyIntolerance>({
          resourceType: 'AllergyIntolerance',
          patient: createReference(patient),
          clinicalStatus: { text: 'active' },
        });

        // Search by patient
        const searchResult = await repo.search({
          resourceType: 'AllergyIntolerance',
          filters: [
            {
              code: 'patient',
              operator: Operator.EQUALS,
              value: patient.id as string,
            },
          ],
        });
        expect(searchResult.entry?.[0]?.resource?.id).toEqual(allergyIntolerance.id);
      }));

    test('Subject search without resource type', () =>
      withTestContext(async () => {
        // Create Patient
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
        });

        // Create Observation
        const observation = await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          code: { text: 'test' },
          subject: createReference(patient),
        });

        // Search by patient
        const searchResult = await repo.search({
          resourceType: 'Observation',
          filters: [
            {
              code: 'subject',
              operator: Operator.EQUALS,
              value: patient.id as string,
            },
          ],
        });
        expect(searchResult.entry?.[0]?.resource?.id).toEqual(observation.id);
      }));

    test('Chained search on array columns using reference tables', () =>
      withTestContext(async () => {
        config.chainedSearchWithReferenceTables = true;

        // Create Practitioner
        const pcp = await repo.createResource<Practitioner>({
          resourceType: 'Practitioner',
        });
        // Create Patient
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          generalPractitioner: [createReference(pcp)],
        });

        // Create CareTeam
        const code = randomUUID();
        const categorySystem = 'http://example.com/care-team-category';
        await repo.createResource<CareTeam>({
          resourceType: 'CareTeam',
          category: [
            {
              coding: [
                {
                  system: categorySystem,
                  code,
                  display: 'Public health-focused care team',
                },
              ],
            },
          ],
          participant: [{ member: createReference(pcp) }],
        });

        // Search chain
        const searchResult = await repo.search(
          parseSearchRequest(
            `Patient?general-practitioner:Practitioner._has:CareTeam:participant:category=${categorySystem}|${code}`
          )
        );
        expect(searchResult.entry?.[0]?.resource?.id).toEqual(patient.id);
      }));

    test('Chained search on single columns using reference tables', () =>
      withTestContext(async () => {
        config.chainedSearchWithReferenceTables = true;

        const code = randomUUID();
        // Create linked resources
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
        });
        const encounter = await repo.createResource<Encounter>({
          resourceType: 'Encounter',
          status: 'finished',
          class: { system: 'http://example.com/appt-type', code },
        });
        const observation = await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          code: { text: 'Throat culture' },
          subject: createReference(patient),
          encounter: createReference(encounter),
        });
        await repo.createResource<DiagnosticReport>({
          resourceType: 'DiagnosticReport',
          status: 'final',
          code: { text: 'Strep test' },
          encounter: createReference(encounter),
          result: [createReference(observation)],
        });

        const result = await repo.search(
          parseSearchRequest(`Patient?_has:Observation:subject:encounter:Encounter.class=${code}`)
        );
        expect(result.entry?.[0]?.resource?.id).toEqual(patient.id);
      }));

    // TODO: To be removed when reference table migration is complete
    test('Chained search on array columns using reference strings', () =>
      withTestContext(async () => {
        config.chainedSearchWithReferenceTables = false;

        // Create Practitioner
        const pcp = await repo.createResource<Practitioner>({
          resourceType: 'Practitioner',
        });
        // Create Patient
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          generalPractitioner: [createReference(pcp)],
        });

        // Create CareTeam
        const code = randomUUID();
        const categorySystem = 'http://example.com/care-team-category';
        await repo.createResource<CareTeam>({
          resourceType: 'CareTeam',
          category: [
            {
              coding: [
                {
                  system: categorySystem,
                  code,
                  display: 'Public health-focused care team',
                },
              ],
            },
          ],
          participant: [{ member: createReference(pcp) }],
        });

        // Search chain
        const searchResult = await repo.search(
          parseSearchRequest(
            `Patient?general-practitioner:Practitioner._has:CareTeam:participant:category=${categorySystem}|${code}`
          )
        );
        expect(searchResult.entry?.[0]?.resource?.id).toEqual(patient.id);
      }));

    // TODO: To be removed when reference table migration is complete
    test('Chained search on single columns using reference strings', () =>
      withTestContext(async () => {
        config.chainedSearchWithReferenceTables = false;

        const code = randomUUID();
        // Create linked resources
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
        });
        const encounter = await repo.createResource<Encounter>({
          resourceType: 'Encounter',
          status: 'finished',
          class: { system: 'http://example.com/appt-type', code },
        });
        const observation = await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          code: { text: 'Throat culture' },
          subject: createReference(patient),
          encounter: createReference(encounter),
        });
        await repo.createResource<DiagnosticReport>({
          resourceType: 'DiagnosticReport',
          status: 'final',
          code: { text: 'Strep test' },
          encounter: createReference(encounter),
          result: [createReference(observation)],
        });

        const result = await repo.search(
          parseSearchRequest(`Patient?_has:Observation:subject:encounter:Encounter.class=${code}`)
        );
        expect(result.entry?.[0]?.resource?.id).toEqual(patient.id);
      }));

    test('Rejects too long chained search', () =>
      withTestContext(async () => {
        await expect(() =>
          repo.search(
            parseSearchRequest(
              `Patient?_has:Observation:subject:encounter:Encounter._has:DiagnosticReport:encounter:result.specimen.parent.collected=2023`
            )
          )
        ).rejects.toEqual(new Error('Search chains longer than three links are not currently supported'));
      }));

    test.each([
      ['Patient?organization.invalid.name=Kaiser', 'Invalid search parameter in chain: Organization?invalid'],
      ['Patient?organization.invalid=true', 'Invalid search parameter at end of chain: Organization?invalid'],
      [
        'Patient?general-practitioner.qualification-period=2023',
        'Unable to identify next resource type for search parameter: Patient?general-practitioner',
      ],
      ['Patient?_has:Observation:invalid:status=active', 'Invalid search parameter in chain: Observation?invalid'],
      [
        'Patient?_has:Observation:encounter:status=active',
        'Invalid reverse chain link: search parameter Observation?encounter does not refer to Patient',
      ],
      ['Patient?_has:Observation:status=active', 'Invalid search chain: _has:Observation:status'],
    ])('Invalid chained search parameters: %s', (searchString: string, errorMsg: string) => {
      return withTestContext(async () =>
        expect(repo.search(parseSearchRequest(searchString))).rejects.toEqual(new Error(errorMsg))
      );
    });

    test('Chained search with modifier', () =>
      withTestContext(async () => {
        const code = randomUUID();
        // Create linked resources
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
        });
        const encounter = await repo.createResource<Encounter>({
          resourceType: 'Encounter',
          status: 'finished',
          class: { system: 'http://example.com/appt-type', code },
        });
        await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          code: { text: 'Throat culture' },
          subject: createReference(patient),
          encounter: createReference(encounter),
        });

        const result = await repo.search(
          parseSearchRequest(
            `Patient?_has:Observation:subject:encounter:Encounter.class=${code}&_has:Observation:subject:encounter:Encounter.status:not=cancelled`
          )
        );
        expect(result.entry?.[0]?.resource?.id).toEqual(patient.id);
      }));

    test('Include references success', () =>
      withTestContext(async () => {
        const patient = await repo.createResource<Patient>({ resourceType: 'Patient' });
        const order = await repo.createResource<ServiceRequest>({
          resourceType: 'ServiceRequest',
          status: 'active',
          intent: 'order',
          subject: createReference(patient),
        });
        const bundle = await repo.search({
          resourceType: 'ServiceRequest',
          include: [
            {
              resourceType: 'ServiceRequest',
              searchParam: 'subject',
            },
          ],
          total: 'accurate',
          filters: [{ code: '_id', operator: Operator.EQUALS, value: order.id as string }],
        });
        expect(bundle.total).toEqual(1);
        expect(bundleContains(bundle, order)).toMatchObject<BundleEntry>({ search: { mode: 'match' } });
        expect(bundleContains(bundle, patient)).toMatchObject<BundleEntry>({ search: { mode: 'include' } });
      }));

    test('Include canonical success', () =>
      withTestContext(async () => {
        const canonicalURL = 'http://example.com/fhir/Questionnaire/PHQ-9/' + randomUUID();
        const questionnaire = await repo.createResource<Questionnaire>({
          resourceType: 'Questionnaire',
          status: 'active',
          url: canonicalURL,
        });
        const response = await repo.createResource<QuestionnaireResponse>({
          resourceType: 'QuestionnaireResponse',
          status: 'in-progress',
          questionnaire: canonicalURL,
        });
        const bundle = await repo.search({
          resourceType: 'QuestionnaireResponse',
          include: [
            {
              resourceType: 'QuestionnaireResponse',
              searchParam: 'questionnaire',
            },
          ],
          total: 'accurate',
          filters: [{ code: '_id', operator: Operator.EQUALS, value: response.id as string }],
        });
        expect(bundle.total).toEqual(1);
        expect(bundleContains(bundle, response)).toMatchObject<BundleEntry>({ search: { mode: 'match' } });
        expect(bundleContains(bundle, questionnaire)).toMatchObject<BundleEntry>({ search: { mode: 'include' } });
      }));

    test('Include PlanDefinition mixed types', () =>
      withTestContext(async () => {
        const canonical = 'http://example.com/fhir/R4/ActivityDefinition/' + randomUUID();
        const uri = 'http://example.com/fhir/R4/ActivityDefinition/' + randomUUID();
        const plan = await repo.createResource<PlanDefinition>({
          resourceType: 'PlanDefinition',
          status: 'active',
          action: [{ definitionCanonical: canonical }, { definitionUri: uri }],
        });
        const activity1 = await repo.createResource<ActivityDefinition>({
          resourceType: 'ActivityDefinition',
          status: 'active',
          url: canonical,
        });
        const activity2 = await repo.createResource<ActivityDefinition>({
          resourceType: 'ActivityDefinition',
          status: 'active',
          url: uri,
        });
        const bundle = await repo.search({
          resourceType: 'PlanDefinition',
          include: [
            {
              resourceType: 'PlanDefinition',
              searchParam: 'definition',
            },
          ],
          total: 'accurate',
          filters: [{ code: '_id', operator: Operator.EQUALS, value: plan.id as string }],
        });
        expect(bundle.total).toEqual(1);
        expect(bundleContains(bundle, plan)).toMatchObject<BundleEntry>({ search: { mode: 'match' } });
        expect(bundleContains(bundle, activity1)).toMatchObject<BundleEntry>({ search: { mode: 'include' } });
        expect(bundleContains(bundle, activity2)).toMatchObject<BundleEntry>({ search: { mode: 'include' } });
      }));

    test('Include references invalid search param', async () =>
      withTestContext(async () => {
        try {
          await repo.search({
            resourceType: 'ServiceRequest',
            include: [
              {
                resourceType: 'ServiceRequest',
                searchParam: 'xyz',
              },
            ],
          });
        } catch (err) {
          const outcome = (err as OperationOutcomeError).outcome;
          expect(outcome.issue?.[0]?.details?.text).toEqual('Invalid include parameter: ServiceRequest:xyz');
        }
      }));

    test('Reverse include Provenance', () =>
      withTestContext(async () => {
        const family = randomUUID();

        const practitioner1 = await repo.createResource<Practitioner>({
          resourceType: 'Practitioner',
          name: [{ given: ['Homer'], family }],
        });

        const practitioner2 = await repo.createResource<Practitioner>({
          resourceType: 'Practitioner',
          name: [{ given: ['Marge'], family }],
        });

        const searchRequest: SearchRequest = {
          resourceType: 'Practitioner',
          filters: [{ code: 'name', operator: Operator.EQUALS, value: family }],
          revInclude: [
            {
              resourceType: 'Provenance',
              searchParam: 'target',
            },
          ],
        };

        const searchResult1 = await repo.search(searchRequest);
        expect(searchResult1.entry).toHaveLength(2);
        expect(bundleContains(searchResult1, practitioner1)).toBeTruthy();
        expect(bundleContains(searchResult1, practitioner2)).toBeTruthy();

        const provenance1 = await repo.createResource<Provenance>({
          resourceType: 'Provenance',
          target: [createReference(practitioner1)],
          agent: [{ who: createReference(practitioner1) }],
          recorded: new Date().toISOString(),
        });

        const provenance2 = await repo.createResource<Provenance>({
          resourceType: 'Provenance',
          target: [createReference(practitioner2)],
          agent: [{ who: createReference(practitioner2) }],
          recorded: new Date().toISOString(),
        });

        const searchResult2 = await repo.search(searchRequest);
        expect(searchResult2.entry).toHaveLength(4);
        expect(bundleContains(searchResult2, practitioner1)).toMatchObject<BundleEntry>({ search: { mode: 'match' } });
        expect(bundleContains(searchResult2, practitioner2)).toMatchObject<BundleEntry>({ search: { mode: 'match' } });
        expect(bundleContains(searchResult2, provenance1)).toMatchObject<BundleEntry>({ search: { mode: 'include' } });
        expect(bundleContains(searchResult2, provenance2)).toMatchObject<BundleEntry>({ search: { mode: 'include' } });
      }));

    test('Reverse include canonical', () =>
      withTestContext(async () => {
        const canonicalURL = 'http://example.com/fhir/Questionnaire/PHQ-9/' + randomUUID();
        const questionnaire = await repo.createResource<Questionnaire>({
          resourceType: 'Questionnaire',
          status: 'active',
          url: canonicalURL,
        });
        const response = await repo.createResource<QuestionnaireResponse>({
          resourceType: 'QuestionnaireResponse',
          status: 'in-progress',
          questionnaire: canonicalURL,
        });
        const bundle = await repo.search({
          resourceType: 'Questionnaire',
          revInclude: [
            {
              resourceType: 'QuestionnaireResponse',
              searchParam: 'questionnaire',
            },
          ],
          total: 'accurate',
          filters: [{ code: '_id', operator: Operator.EQUALS, value: questionnaire.id as string }],
        });
        expect(bundle.total).toEqual(1);
        expect(bundleContains(bundle, questionnaire)).toMatchObject<BundleEntry>({ search: { mode: 'match' } });
        expect(bundleContains(bundle, response)).toMatchObject<BundleEntry>({ search: { mode: 'include' } });
      }));

    test('_include:iterate', () =>
      withTestContext(async () => {
        /*
    Construct resources for the search to operate on.  The test search query and resource graph it will act on are shown below.
    
    Query: /Patient?identifier=patient
      &_include=Patient:organization
      &_include:iterate=Patient:link
      &_include:iterate=Patient:general-practitioner

    ┌──────────────────────────────────┐            
    │patient                           │            
    └┬────────┬────────┬────────┬─────┬┘            
    ┌▽──────┐┌▽──────┐┌▽──────┐┌▽───┐┌▽────────────┐
    │linked2││linked1││related││org1││practitioner1│
    └┬──────┘└┬──────┘└───────┘└────┘└─────────────┘
     │┌───────▽───────┐
     ││linked3        │
     │└┬────────────┬─┘                
    ┌▽─▽──────────┐┌▽─────┐                         
    │practitioner2││org2 *│                         
    └─────────────┘└──────┘                         
      * omitted from search results

    This verifies the following behaviors of the :iterate modifier:
    1. _include w/ :iterate recursively applies the same parameter (Patient:link)
    2. _include w/ :iterate applies to resources from other _include parameters (Patient:general-practitioner)
    3. _include w/o :iterate does not apply recursively (Patient:organization)
    4. Resources which are included multiple times are deduplicated in the search results
    */
        const rootPatientIdentifier = randomUUID();
        const organization1 = await repo.createResource<Organization>({
          resourceType: 'Organization',
          name: 'org1',
        });
        const organization2 = await repo.createResource<Organization>({
          resourceType: 'Organization',
          name: 'org2',
        });
        const practitioner1 = await repo.createResource<Practitioner>({ resourceType: 'Practitioner' });
        const practitioner2 = await repo.createResource<Practitioner>({ resourceType: 'Practitioner' });
        const linked3 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          managingOrganization: { reference: `Organization/${organization2.id}` },
          generalPractitioner: [
            {
              reference: `Practitioner/${practitioner2.id}`,
            },
          ],
        });
        const linked1 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          link: [
            {
              other: { reference: `Patient/${linked3.id}` },
              type: 'replaces',
            },
          ],
        });
        const linked2 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          generalPractitioner: [
            {
              reference: `Practitioner/${practitioner2.id}`,
            },
          ],
        });
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          identifier: [
            {
              value: rootPatientIdentifier,
            },
          ],
          link: [
            {
              other: { reference: `Patient/${linked1.id}` },
              type: 'replaces',
            },
            {
              other: { reference: `Patient/${linked2.id}` },
              type: 'replaces',
            },
          ],
          managingOrganization: {
            reference: `Organization/${organization1.id}`,
          },
          generalPractitioner: [
            {
              reference: `Practitioner/${practitioner1.id}`,
            },
          ],
        });

        // Run the test search query
        const bundle = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'identifier',
              operator: Operator.EQUALS,
              value: rootPatientIdentifier,
            },
          ],
          include: [
            { resourceType: 'Patient', searchParam: 'organization' },
            { resourceType: 'Patient', searchParam: 'link', modifier: Operator.ITERATE },
            { resourceType: 'Patient', searchParam: 'general-practitioner', modifier: Operator.ITERATE },
          ],
        });

        const expected = [
          `match:Patient/${patient.id}`,
          `include:Patient/${linked1.id}`,
          `include:Patient/${linked2.id}`,
          `include:Patient/${linked3.id}`,
          `include:Organization/${organization1.id}`,
          `include:Practitioner/${practitioner1.id}`,
          `include:Practitioner/${practitioner2.id}`,
        ].sort();

        expect(
          bundle.entry?.map((e) => `${e.search?.mode}:${e.resource?.resourceType}/${e.resource?.id}`).sort()
        ).toEqual(expected);
      }));

    test('_revinclude:iterate', () =>
      withTestContext(async () => {
        /*
    Construct resources for the search to operate on.  The test search query and resource graph it will act on are shown below.
    
    Query: /Patient?identifier=patient
      &_revinclude=Patient:link
      &_revinclude:iterate=Observation:subject
      &_revinclude:iterate=Observation:has-member

    ┌─────────┐┌────────────┐┌────────────┐
    │linked3 *││observation3││observation4│
    └┬────────┘└┬───────────┘└┬───────────┘
    ┌▽──────┐┌──▽────┐┌───────▽────┐       
    │linked1││linked2││observation2│       
    └┬──────┘└┬──────┘└┬───────────┘       
     │        │┌───────▽─────────┐         
     │        ││observation1     │         
     │        │└┬────────────────┘         
    ┌▽────────▽─▽┐                         
    │patient     │                         
    └────────────┘                         
      * omitted from search results

    This verifies the following behaviors of the :iterate modifier:
    1. _revinclude w/ :iterate recursively applies the same parameter (Observation:has-member)
    2. _revinclude w/ :iterate applies to resources from other _revinclude parameters (Observation:subject)
    3. _revinclude w/o :iterate does not apply recursively (Patient:link)
    */
        const rootPatientIdentifier = randomUUID();
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          identifier: [
            {
              value: rootPatientIdentifier,
            },
          ],
        });
        const linked1 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          link: [
            {
              other: { reference: `Patient/${patient.id}` },
              type: 'replaced-by',
            },
          ],
        });
        const linked2 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          link: [
            {
              other: { reference: `Patient/${patient.id}` },
              type: 'replaced-by',
            },
          ],
        });
        await repo.createResource<Patient>({
          resourceType: 'Patient',
          link: [
            {
              other: { reference: `Patient/${linked1.id}` },
              type: 'replaced-by',
            },
          ],
        });
        const baseObservation: Observation = {
          resourceType: 'Observation',
          status: 'final',
          code: {
            coding: [
              {
                system: LOINC,
                code: 'fake',
              },
            ],
          },
        };
        const observation1 = await repo.createResource<Observation>({
          ...baseObservation,
          subject: {
            reference: `Patient/${patient.id}`,
          },
        });
        const observation2 = await repo.createResource<Observation>({
          ...baseObservation,
          subject: {
            display: 'Alex J. Chalmers',
          },
          hasMember: [
            {
              reference: `Observation/${observation1.id}`,
            },
          ],
        });
        const observation3 = await repo.createResource<Observation>({
          ...baseObservation,
          subject: {
            reference: `Patient/${linked2.id}`,
          },
        });
        const observation4 = await repo.createResource<Observation>({
          ...baseObservation,
          subject: {
            display: 'Alex J. Chalmers',
          },
          hasMember: [
            {
              reference: `Observation/${observation2.id}`,
            },
          ],
        });

        // Run the test search query
        const bundle = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'identifier',
              operator: Operator.EQUALS,
              value: rootPatientIdentifier,
            },
          ],
          revInclude: [
            { resourceType: 'Patient', searchParam: 'link' },
            { resourceType: 'Observation', searchParam: 'subject', modifier: Operator.ITERATE },
            { resourceType: 'Observation', searchParam: 'has-member', modifier: Operator.ITERATE },
          ],
        });

        const expected = [
          `match:Patient/${patient.id}`,
          `include:Patient/${linked1.id}`,
          `include:Patient/${linked2.id}`,
          `include:Observation/${observation1.id}`,
          `include:Observation/${observation2.id}`,
          `include:Observation/${observation3.id}`,
          `include:Observation/${observation4.id}`,
        ].sort();

        expect(
          bundle.entry?.map((e) => `${e.search?.mode}:${e.resource?.resourceType}/${e.resource?.id}`).sort()
        ).toEqual(expected);
      }));

    test('_include depth limit', () =>
      withTestContext(async () => {
        const rootPatientIdentifier = randomUUID();
        const linked6 = await repo.createResource<Patient>({
          resourceType: 'Patient',
        });
        const linked5 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          link: [
            {
              other: { reference: `Patient/${linked6.id}` },
              type: 'replaces',
            },
          ],
        });
        const linked4 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          link: [
            {
              other: { reference: `Patient/${linked5.id}` },
              type: 'replaces',
            },
          ],
        });
        const linked3 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          link: [
            {
              other: { reference: `Patient/${linked4.id}` },
              type: 'replaces',
            },
          ],
        });
        const linked2 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          link: [
            {
              other: { reference: `Patient/${linked3.id}` },
              type: 'replaces',
            },
          ],
        });
        const linked1 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          link: [
            {
              other: { reference: `Patient/${linked2.id}` },
              type: 'replaces',
            },
          ],
        });
        await repo.createResource<Patient>({
          resourceType: 'Patient',
          identifier: [
            {
              value: rootPatientIdentifier,
            },
          ],
          link: [
            {
              other: { reference: `Patient/${linked1.id}` },
              type: 'replaces',
            },
          ],
        });

        return expect(
          repo.search({
            resourceType: 'Patient',
            filters: [
              {
                code: 'identifier',
                operator: Operator.EQUALS,
                value: rootPatientIdentifier,
              },
            ],
            include: [{ resourceType: 'Patient', searchParam: 'link', modifier: Operator.ITERATE }],
          })
        ).rejects.toBeDefined();
      }));

    test('_include on empty search results', () =>
      withTestContext(async () => {
        return expect(
          repo.search({
            resourceType: 'Patient',
            filters: [
              {
                code: 'identifier',
                operator: Operator.EQUALS,
                value: randomUUID(),
              },
            ],
            include: [{ resourceType: 'Patient', searchParam: 'link', modifier: Operator.ITERATE }],
          })
        ).resolves.toMatchObject<Bundle>({
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [],
          total: undefined,
        });
      }));

    test('_include on page boundary', () =>
      withTestContext(async () => {
        const mrn = randomUUID();
        const gp1 = await repo.createResource<Practitioner>({
          resourceType: 'Practitioner',
        });
        const patient1 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          identifier: [{ value: mrn }],
          generalPractitioner: [createReference(gp1)],
        });
        const gp2 = await repo.createResource<Practitioner>({
          resourceType: 'Practitioner',
        });
        const patient2 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          identifier: [{ value: mrn }],
          generalPractitioner: [createReference(gp2)],
        });

        const searchRequest: SearchRequest = {
          resourceType: 'Patient',
          filters: [
            {
              code: 'identifier',
              operator: Operator.EQUALS,
              value: mrn,
            },
          ],
          sortRules: [{ code: '_lastUpdated' }],
          include: [{ resourceType: 'Patient', searchParam: 'general-practitioner' }],
          count: 1,
        };
        await expect(repo.search(searchRequest)).resolves.toMatchObject<Bundle>({
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [
            expect.objectContaining<BundleEntry>({
              fullUrl: expect.stringContaining(getReferenceString(patient1)),
              search: { mode: 'match' },
            }),
            expect.objectContaining<BundleEntry>({
              fullUrl: expect.stringContaining(getReferenceString(gp1)),
              search: { mode: 'include' },
            }),
          ],
        });

        searchRequest.count = 2;
        await expect(repo.search(searchRequest)).resolves.toMatchObject<Bundle>({
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [
            expect.objectContaining<BundleEntry>({
              fullUrl: expect.stringContaining(getReferenceString(patient1)),
              search: { mode: 'match' },
            }),
            expect.objectContaining<BundleEntry>({
              fullUrl: expect.stringContaining(getReferenceString(patient2)),
              search: { mode: 'match' },
            }),
            expect.objectContaining<BundleEntry>({
              fullUrl: expect.stringContaining(getReferenceString(gp1)),
              search: { mode: 'include' },
            }),
            expect.objectContaining<BundleEntry>({
              fullUrl: expect.stringContaining(getReferenceString(gp2)),
              search: { mode: 'include' },
            }),
          ],
        });
      }));

    test('DiagnosticReport category with system', () =>
      withTestContext(async () => {
        const code = randomUUID();
        const dr = await repo.createResource<DiagnosticReport>({
          resourceType: 'DiagnosticReport',
          status: 'final',
          code: { coding: [{ code }] },
          category: [{ coding: [{ system: LOINC, code: 'LP217198-3' }] }],
        });

        const bundle = await repo.search({
          resourceType: 'DiagnosticReport',
          filters: [
            {
              code: 'code',
              operator: Operator.EQUALS,
              value: code,
            },
            {
              code: 'category',
              operator: Operator.EQUALS,
              value: `${LOINC}|LP217198-3`,
            },
          ],
          count: 1,
        });

        expect(bundleContains(bundle, dr)).toBeTruthy();
      }));

    test('Encounter.period date search', () =>
      withTestContext(async () => {
        const e = await repo.createResource<Encounter>({
          resourceType: 'Encounter',
          identifier: [{ value: randomUUID() }],
          status: 'finished',
          class: { code: 'test' },
          period: {
            start: '2020-02-01',
            end: '2020-02-02',
          },
        });

        const bundle = await repo.search({
          resourceType: 'Encounter',
          filters: [
            {
              code: 'identifier',
              operator: Operator.EQUALS,
              value: e.identifier?.[0]?.value as string,
            },
            {
              code: 'date',
              operator: Operator.GREATER_THAN,
              value: '2020-01-01',
            },
          ],
          count: 1,
        });

        expect(bundleContains(bundle, e)).toBeTruthy();
      }));

    test('Encounter.period dateTime search', () =>
      withTestContext(async () => {
        const e = await repo.createResource<Encounter>({
          resourceType: 'Encounter',
          identifier: [{ value: randomUUID() }],
          status: 'finished',
          class: { code: 'test' },
          period: {
            start: '2020-02-01T13:30:00Z',
            end: '2020-02-01T14:15:00Z',
          },
        });

        const bundle = await repo.search({
          resourceType: 'Encounter',
          filters: [
            {
              code: 'identifier',
              operator: Operator.EQUALS,
              value: e.identifier?.[0]?.value as string,
            },
            {
              code: 'date',
              operator: Operator.GREATER_THAN,
              value: '2020-02-01T12:00Z',
            },
          ],
          count: 1,
        });

        expect(bundleContains(bundle, e)).toBeTruthy();
      }));

    test('Condition.code system search', () =>
      withTestContext(async () => {
        const p = await repo.createResource({
          resourceType: 'Patient',
          name: [{ family: randomUUID() }],
        });

        const c1 = await repo.createResource<Condition>({
          resourceType: 'Condition',
          subject: createReference(p),
          code: { coding: [{ system: SNOMED, code: '165002' }] },
        });

        const c2 = await repo.createResource<Condition>({
          resourceType: 'Condition',
          subject: createReference(p),
          code: { coding: [{ system: 'https://example.com', code: 'test' }] },
        });

        const bundle = await repo.search({
          resourceType: 'Condition',
          filters: [
            {
              code: 'subject',
              operator: Operator.EQUALS,
              value: getReferenceString(p),
            },
            {
              code: 'code',
              operator: Operator.EQUALS,
              value: `${SNOMED}|`,
            },
          ],
        });

        expect(bundle.entry?.length).toEqual(1);
        expect(bundleContains(bundle, c1)).toBeTruthy();
        expect(bundleContains(bundle, c2)).not.toBeTruthy();
      }));

    test('Condition.code :not next URL', () =>
      withTestContext(async () => {
        const p = await repo.createResource({
          resourceType: 'Patient',
          name: [{ family: randomUUID() }],
        });

        await repo.createResource<Condition>({
          resourceType: 'Condition',
          subject: createReference(p),
          code: { coding: [{ system: SNOMED, code: '165002' }] },
        });

        await repo.createResource<Condition>({
          resourceType: 'Condition',
          subject: createReference(p),
          code: { coding: [{ system: 'https://example.com', code: 'test' }] },
        });

        const bundle = await repo.search(
          parseSearchRequest(`https://x/Condition?subject=${getReferenceString(p)}&code:not=x&_count=1&_total=accurate`)
        );
        expect(bundle.entry?.length).toEqual(1);

        const nextUrl = bundle.link?.find((l) => l.relation === 'next')?.url;
        expect(nextUrl).toBeDefined();
        expect(nextUrl).toContain('code:not=x');
      }));

    test('Condition.code :in search', () =>
      withTestContext(async () => {
        // ValueSet: http://hl7.org/fhir/ValueSet/condition-code
        // compose includes codes from http://snomed.info/sct
        // but does not include codes from https://example.com

        const p = await repo.createResource({
          resourceType: 'Patient',
          name: [{ family: randomUUID() }],
        });

        const c1 = await repo.createResource<Condition>({
          resourceType: 'Condition',
          subject: createReference(p),
          code: { coding: [{ system: SNOMED, code: '165002' }] },
        });

        const c2 = await repo.createResource<Condition>({
          resourceType: 'Condition',
          subject: createReference(p),
          code: { coding: [{ system: 'https://example.com', code: 'test' }] },
        });

        const bundle = await repo.search({
          resourceType: 'Condition',
          filters: [
            {
              code: 'subject',
              operator: Operator.EQUALS,
              value: getReferenceString(p),
            },
            {
              code: 'code',
              operator: Operator.IN,
              value: 'http://hl7.org/fhir/ValueSet/condition-code',
            },
          ],
        });

        expect(bundle.entry?.length).toEqual(1);
        expect(bundleContains(bundle, c1)).toBeTruthy();
        expect(bundleContains(bundle, c2)).not.toBeTruthy();
      }));

    test('Reference identifier search', () =>
      withTestContext(async () => {
        const code = randomUUID();

        const c1 = await repo.createResource<Condition>({
          resourceType: 'Condition',
          code: { coding: [{ code }] },
          subject: { identifier: { system: 'mrn', value: '123456' } },
        });

        const c2 = await repo.createResource<Condition>({
          resourceType: 'Condition',
          code: { coding: [{ code }] },
          subject: { identifier: { system: 'xyz', value: '123456' } },
        });

        // Search with system
        const bundle1 = await repo.search(parseSearchRequest(`Condition?code=${code}&subject:identifier=mrn|123456`));
        expect(bundle1.entry?.length).toEqual(1);
        expect(bundleContains(bundle1, c1)).toBeTruthy();
        expect(bundleContains(bundle1, c2)).not.toBeTruthy();

        // Search without system
        const bundle2 = await repo.search(parseSearchRequest(`Condition?code=${code}&subject:identifier=123456`));
        expect(bundle2.entry?.length).toEqual(2);
        expect(bundleContains(bundle2, c1)).toBeTruthy();
        expect(bundleContains(bundle2, c2)).toBeTruthy();

        // Search with count
        const bundle3 = await repo.search(
          parseSearchRequest(`Condition?code=${code}&subject:identifier=mrn|123456&_total=accurate`)
        );
        expect(bundle3.entry?.length).toEqual(1);
        expect(bundle3.total).toBe(1);
        expect(bundleContains(bundle3, c1)).toBeTruthy();
        expect(bundleContains(bundle3, c2)).not.toBeTruthy();
      }));

    test('Task patient identifier search', () =>
      withTestContext(async () => {
        const identifier = randomUUID();

        // Create a Task with a patient identifier reference _with_ Reference.type
        const task1 = await repo.createResource<Task>({
          resourceType: 'Task',
          status: 'accepted',
          intent: 'order',
          for: {
            type: 'Patient',
            identifier: { system: 'mrn', value: identifier },
          },
        });

        // Create a Task with a patient identifier reference _without_ Reference.type
        const task2 = await repo.createResource<Task>({
          resourceType: 'Task',
          status: 'accepted',
          intent: 'order',
          for: {
            identifier: { system: 'mrn', value: identifier },
          },
        });

        // Search by "subject"
        // This will include both Tasks, because the "subject" search parameter does not care about "type"
        const bundle1 = await repo.search(
          parseSearchRequest(`Task?subject:identifier=mrn|${identifier}&_total=accurate`)
        );
        expect(bundle1.total).toEqual(2);
        expect(bundle1.entry?.length).toEqual(2);
        expect(bundleContains(bundle1, task1)).toBeTruthy();
        expect(bundleContains(bundle1, task2)).toBeTruthy();

        // Search by "patient"
        // This will only include the Task with the explicit "Patient" type, because the "patient" search parameter does care about "type"
        const bundle2 = await repo.search(
          parseSearchRequest(`Task?patient:identifier=mrn|${identifier}&_total=accurate`)
        );
        expect(bundle2.total).toEqual(1);
        expect(bundle2.entry?.length).toEqual(1);
        expect(bundleContains(bundle2, task1)).toBeTruthy();
        expect(bundleContains(bundle2, task2)).not.toBeTruthy();
      }));

    test('Resource search params', () =>
      withTestContext(async () => {
        const patientIdentifier = randomUUID();
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          identifier: [{ system: 'http://example.com', value: patientIdentifier }],
          meta: {
            profile: ['http://example.com/fhir/a-patient-profile'],
            security: [{ system: 'http://hl7.org/fhir/v3/Confidentiality', code: 'N' }],
            source: 'http://example.org',
            tag: [{ system: 'http://hl7.org/fhir/v3/ObservationValue', code: 'SUBSETTED' }],
          },
        });
        const identifierFilter = {
          code: 'identifier',
          operator: Operator.EQUALS,
          value: patientIdentifier,
        };

        const bundle1 = await repo.search({
          resourceType: 'Patient',
          filters: [
            identifierFilter,
            {
              code: '_profile',
              operator: Operator.EQUALS,
              value: 'http://example.com/fhir/a-patient-profile',
            },
          ],
        });
        expect(bundleContains(bundle1, patient)).toBeTruthy();

        const bundle2 = await repo.search({
          resourceType: 'Patient',
          filters: [
            identifierFilter,
            {
              code: '_security',
              operator: Operator.EQUALS,
              value: 'http://hl7.org/fhir/v3/Confidentiality|N',
            },
          ],
        });
        expect(bundleContains(bundle2, patient)).toBeTruthy();

        const bundle3 = await repo.search({
          resourceType: 'Patient',
          filters: [
            identifierFilter,
            {
              code: '_source',
              operator: Operator.EQUALS,
              value: 'http://example.org',
            },
          ],
        });
        expect(bundleContains(bundle3, patient)).toBeTruthy();

        const bundle4 = await repo.search({
          resourceType: 'Patient',
          filters: [
            identifierFilter,
            {
              code: '_tag',
              operator: Operator.EQUALS,
              value: 'http://hl7.org/fhir/v3/ObservationValue|SUBSETTED',
            },
          ],
        });
        expect(bundleContains(bundle4, patient)).toBeTruthy();
      }));

    test('Token :text search', () =>
      withTestContext(async () => {
        const patient = await repo.createResource<Patient>({ resourceType: 'Patient' });

        const obs1 = await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          code: { text: randomUUID() },
          subject: createReference(patient),
        });

        const obs2 = await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          code: { coding: [{ display: randomUUID() }] },
          subject: createReference(patient),
        });

        const result1 = await repo.search({
          resourceType: 'Observation',
          filters: [{ code: 'code', operator: Operator.TEXT, value: obs1.code?.text as string }],
        });
        expect(result1.entry?.[0]?.resource?.id).toEqual(obs1.id);

        const result2 = await repo.search({
          resourceType: 'Observation',
          filters: [{ code: 'code', operator: Operator.TEXT, value: obs2.code?.coding?.[0]?.display as string }],
        });
        expect(result2.entry?.[0]?.resource?.id).toEqual(obs2.id);
      }));

    test('_filter search', () =>
      withTestContext(async () => {
        const patient = await repo.createResource<Patient>({ resourceType: 'Patient' });
        const statuses: ('preliminary' | 'final')[] = ['preliminary', 'final'];
        const codes = ['123', '456'];
        const observations = [];

        for (const status of statuses) {
          for (const code of codes) {
            observations.push(
              await repo.createResource<Observation>({
                resourceType: 'Observation',
                subject: createReference(patient),
                status,
                code: { coding: [{ code }] },
              })
            );
          }
        }

        const result = await repo.search({
          resourceType: 'Observation',
          filters: [
            {
              code: 'subject',
              operator: Operator.EQUALS,
              value: getReferenceString(patient),
            },
            {
              code: '_filter',
              operator: Operator.EQUALS,
              value: '(status eq preliminary and code eq 123) or (not (status eq preliminary) and code eq 456)',
            },
          ],
        });
        expect(result.entry).toHaveLength(2);
      }));

    test('_filter ne', () =>
      withTestContext(async () => {
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Eve'] }],
          managingOrganization: { reference: 'Organization/' + randomUUID() },
        });

        const result = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'organization',
              operator: Operator.EQUALS,
              value: patient.managingOrganization?.reference as string,
            },
            {
              code: '_filter',
              operator: Operator.EQUALS,
              value: 'given ne Eve',
            },
          ],
        });

        expect(result.entry).toHaveLength(0);
      }));

    test('_filter re', () =>
      withTestContext(async () => {
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Eve'] }],
          managingOrganization: { reference: 'Organization/' + randomUUID() },
        });

        const result = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: '_filter',
              operator: Operator.EQUALS,
              value: 'organization re ' + patient.managingOrganization?.reference,
            },
          ],
        });

        expect(result.entry).toHaveLength(1);
        expect(result.entry?.[0]?.resource?.id).toEqual(patient.id);
      }));

    test('_filter with chained search', () =>
      withTestContext(async () => {
        const mrn = randomUUID();
        const npi = randomUUID();
        const patient = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Eve'] }],
          identifier: [{ system: 'http://example.com/mrn', value: mrn }],
        });

        const practitioner = await repo.createResource<Practitioner>({
          resourceType: 'Practitioner',
          name: [{ given: ['Yves'] }],
          identifier: [{ system: 'http://example.com/npi', value: npi }],
        });

        const observation1 = await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          code: {
            text: 'Strep test',
          },
          subject: createReference(patient),
        });

        const observation2 = await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          code: {
            coding: [{ system: 'http://example.com/obs', code: 'STRP' }],
          },
          performer: [createReference(practitioner)],
        });

        const result = await repo.search({
          resourceType: 'Observation',
          filters: [
            {
              code: '_filter',
              operator: Operator.EQUALS,
              value: `subject:Patient.identifier eq http://example.com/mrn|${mrn} or performer:Practitioner.identifier eq http://example.com/npi|${npi}`,
            },
          ],
        });

        expect(result.entry).toHaveLength(2);
        expect(result.entry?.map((e) => e.resource?.id)).toEqual(
          expect.arrayContaining([observation1.id, observation2.id])
        );
      }));

    test('Lookup table exact match with comma disjunction', () =>
      withTestContext(async () => {
        const family = randomUUID();
        const p1 = await repo.createResource({ resourceType: 'Patient', name: [{ given: ['x'], family }] });
        const p2 = await repo.createResource({ resourceType: 'Patient', name: [{ given: ['xx'], family }] });
        const p3 = await repo.createResource({ resourceType: 'Patient', name: [{ given: ['y'], family }] });
        const p4 = await repo.createResource({ resourceType: 'Patient', name: [{ given: ['yy'], family }] });

        const bundle = await repo.search({
          resourceType: 'Patient',
          total: 'accurate',
          filters: [
            {
              code: 'given',
              operator: Operator.EXACT,
              value: 'x,y',
            },
            {
              code: 'family',
              operator: Operator.EXACT,
              value: family,
            },
          ],
        });
        expect(bundle.entry?.length).toEqual(2);
        expect(bundle.total).toEqual(2);
        expect(bundleContains(bundle, p1)).toBeTruthy();
        expect(bundleContains(bundle, p2)).not.toBeTruthy();
        expect(bundleContains(bundle, p3)).toBeTruthy();
        expect(bundleContains(bundle, p4)).not.toBeTruthy();
      }));

    test('Duplicate rows from token lookup', () =>
      withTestContext(async () => {
        const code = randomUUID();

        const p = await repo.createResource({ resourceType: 'Patient' });
        const s = await repo.createResource({
          resourceType: 'ServiceRequest',
          subject: createReference(p),
          status: 'active',
          intent: 'order',
          category: [
            {
              text: code,
              coding: [
                {
                  system: 'https://example.com/category',
                  code,
                },
              ],
            },
          ],
        });

        const bundle = await repo.search<ServiceRequest>({
          resourceType: 'ServiceRequest',
          filters: [{ code: 'category', operator: Operator.EQUALS, value: code }],
        });
        expect(bundle.entry?.length).toEqual(1);
        expect(bundleContains(bundle, s)).toBeTruthy();
      }));

    test('Filter task by due date', () =>
      withTestContext(async () => {
        const code = randomUUID();

        // Create 3 tasks
        // Mix of "no due date", using "start", and using "end"
        const task1 = await repo.createResource<Task>({
          resourceType: 'Task',
          status: 'requested',
          intent: 'order',
          code: { coding: [{ code }] },
        });
        const task2 = await repo.createResource<Task>({
          resourceType: 'Task',
          status: 'requested',
          intent: 'order',
          code: { coding: [{ code }] },
          restriction: { period: { start: '2023-06-02T00:00:00.000Z' } },
        });
        const task3 = await repo.createResource<Task>({
          resourceType: 'Task',
          status: 'requested',
          intent: 'order',
          code: { coding: [{ code }] },
          restriction: { period: { end: '2023-06-03T00:00:00.000Z' } },
        });

        // Sort and filter by due date
        const bundle = await repo.search<Task>({
          resourceType: 'Task',
          filters: [
            { code: 'code', operator: Operator.EQUALS, value: code },
            { code: 'due-date', operator: Operator.GREATER_THAN, value: '2023-06-01T00:00:00.000Z' },
          ],
          sortRules: [{ code: 'due-date' }],
        });
        expect(bundle.entry?.length).toEqual(2);
        expect(bundle.entry?.[0]?.resource?.id).toEqual(task2.id);
        expect(bundle.entry?.[1]?.resource?.id).toEqual(task3.id);
        expect(bundleContains(bundle, task1)).not.toBeTruthy();
      }));

    test('Get estimated count with filter on human name', async () =>
      withTestContext(async () => {
        const result = await repo.search({
          resourceType: 'Patient',
          total: 'estimate',
          filters: [
            {
              code: 'name',
              operator: Operator.EQUALS,
              value: 'John',
            },
          ],
        });
        expect(result.total).toBeDefined();
        expect(typeof result.total).toBe('number');
      }));

    test('Organization by name', () =>
      withTestContext(async () => {
        const org = await repo.createResource<Organization>({
          resourceType: 'Organization',
          name: randomUUID(),
        });
        const result = await repo.search({
          resourceType: 'Organization',
          filters: [
            {
              code: 'name',
              operator: Operator.EQUALS,
              value: `wrongname,${(org.name as string).slice(0, 5)}`,
            },
          ],
        });
        expect(result.entry?.length).toBe(1);
      }));

    test('Ambiguous search columns', () =>
      withTestContext(async () => {
        const result = await repo.search({
          resourceType: 'ProjectMembership',
          filters: [
            {
              code: 'user:User.email',
              operator: Operator.EQUALS,
              value: randomUUID() + '@example.com',
            },
          ],
        });
        expect(result.entry?.length).toBe(0);
      }));

    test('Patient by name with stop word', () =>
      withTestContext(async () => {
        const seed = randomUUID();
        await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [
            {
              given: [seed + 'Justin', 'Wynn'],
              family: 'Sanders' + seed,
            },
          ],
        });
        const result = await repo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'name',
              operator: Operator.CONTAINS,
              value: `${seed.slice(-3)}just`,
            },
          ],
        });
        expect(result.entry?.length).toBe(1);
      }));

    test('Sort by ID', () =>
      withTestContext(async () => {
        const org = await repo.createResource<Organization>({ resourceType: 'Organization', name: 'org1' });
        const managingOrganization = createReference(org);
        await repo.createResource<Patient>({ resourceType: 'Patient', managingOrganization });
        await repo.createResource<Patient>({ resourceType: 'Patient', managingOrganization });

        const result1 = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: 'organization', operator: Operator.EQUALS, value: getReferenceString(org) }],
          sortRules: [{ code: '_id', descending: false }],
        });
        expect(result1.entry).toHaveLength(2);
        expect(result1.entry?.[0]?.resource?.id?.localeCompare(result1.entry?.[1]?.resource?.id as string)).toBe(-1);

        const result2 = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: 'organization', operator: Operator.EQUALS, value: getReferenceString(org) }],
          sortRules: [{ code: '_id', descending: true }],
        });
        expect(result2.entry).toHaveLength(2);
        expect(result2.entry?.[0]?.resource?.id?.localeCompare(result2.entry?.[1]?.resource?.id as string)).toBe(1);
      }));

    test('Numeric parameter', () =>
      withTestContext(async () => {
        const ident = randomUUID();
        const riskAssessment: RiskAssessment = {
          resourceType: 'RiskAssessment',
          status: 'final',
          identifier: [{ value: ident }],
          subject: {
            reference: 'Patient/test',
          },
          prediction: [
            {
              outcome: { text: 'Breast Cancer' },
              probabilityDecimal: 0.000168,
              whenRange: {
                high: { value: 53, unit: 'years' },
              },
            },
            {
              outcome: { text: 'Breast Cancer' },
              probabilityDecimal: 0.000368,
              whenRange: {
                low: { value: 54, unit: 'years' },
                high: { value: 57, unit: 'years' },
              },
            },
            {
              outcome: { text: 'Breast Cancer' },
              probabilityDecimal: 0.000594,
              whenRange: {
                low: { value: 58, unit: 'years' },
                high: { value: 62, unit: 'years' },
              },
            },
            {
              outcome: { text: 'Breast Cancer' },
              probabilityDecimal: 0.000838,
              whenRange: {
                low: { value: 63, unit: 'years' },
                high: { value: 67, unit: 'years' },
              },
            },
          ],
        };

        await repo.createResource(riskAssessment);
        const result = await repo.search({
          resourceType: 'RiskAssessment',
          filters: [
            { code: 'identifier', operator: Operator.EQUALS, value: ident },
            { code: 'probability', operator: Operator.GREATER_THAN, value: '0.0005' },
          ],
        });
        expect(result.entry).toHaveLength(1);
      }));

    test('Disjunction with lookup tables', () =>
      withTestContext(async () => {
        const n1 = randomUUID();
        const n2 = randomUUID();

        const p1 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ family: n1 }],
        });

        const p2 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ family: n2 }],
        });

        const result = await repo.search({
          resourceType: 'Patient',
          filters: [{ code: '_filter', operator: Operator.EQUALS, value: `name co "${n1}" or name co "${n2}"` }],
        });

        expect(result.entry).toHaveLength(2);
        expect(bundleContains(result, p1)).toBeDefined();
        expect(bundleContains(result, p2)).toBeDefined();
      }));

    test('Sort by unknown search parameter', async () =>
      withTestContext(async () => {
        try {
          await repo.search({
            resourceType: 'Patient',
            sortRules: [{ code: 'xyz' }],
          });
        } catch (err) {
          const outcome = normalizeOperationOutcome(err);
          expect(outcome.issue?.[0]?.details?.text).toBe('Unknown search parameter: xyz');
        }
      }));

    test('Date range search', () =>
      withTestContext(async () => {
        const ident = randomUUID();

        const measureReport = await repo.createResource<MeasureReport>({
          resourceType: 'MeasureReport',
          status: 'complete',
          type: 'individual',
          measure: 'http://example.com',
          identifier: [{ value: ident }],
          period: {
            start: '2020-01-01T12:00:00.000Z',
            end: '2020-01-15T12:00:00.000Z',
          },
        });
        expect(measureReport).toBeDefined();

        async function searchByPeriod(operator: Operator, value: string): Promise<boolean> {
          const result = await repo.searchOne<MeasureReport>({
            resourceType: 'MeasureReport',
            filters: [
              { code: 'identifier', operator: Operator.EQUALS, value: ident },
              { code: 'period', operator, value },
            ],
          });
          return !!result;
        }

        expect(await searchByPeriod(Operator.EQUALS, '2019-12-31')).toBe(false);
        expect(await searchByPeriod(Operator.EQUALS, '2020-01-01')).toBe(true);
        expect(await searchByPeriod(Operator.EQUALS, '2020-01-02')).toBe(true);
        expect(await searchByPeriod(Operator.EQUALS, '2020-01-15')).toBe(true);
        expect(await searchByPeriod(Operator.EQUALS, '2020-01-16')).toBe(false);

        expect(await searchByPeriod(Operator.EQUALS, '2020-01-01T11:59:59.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.EQUALS, '2020-01-01T12:00:00.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.EQUALS, '2020-01-15T11:59:59.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.EQUALS, '2020-01-15T12:00:00.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.EQUALS, '2020-01-15T12:00:01.000Z')).toBe(false);

        expect(await searchByPeriod(Operator.NOT_EQUALS, '2019-12-31')).toBe(true);
        expect(await searchByPeriod(Operator.NOT_EQUALS, '2020-01-01')).toBe(false);
        expect(await searchByPeriod(Operator.NOT_EQUALS, '2020-01-02')).toBe(false);
        expect(await searchByPeriod(Operator.NOT_EQUALS, '2020-01-15')).toBe(false);
        expect(await searchByPeriod(Operator.NOT_EQUALS, '2020-01-16')).toBe(true);

        expect(await searchByPeriod(Operator.NOT_EQUALS, '2020-01-01T11:59:59.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.NOT_EQUALS, '2020-01-01T12:00:00.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.NOT_EQUALS, '2020-01-15T11:59:59.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.NOT_EQUALS, '2020-01-15T12:00:00.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.NOT_EQUALS, '2020-01-15T12:00:01.000Z')).toBe(true);

        expect(await searchByPeriod(Operator.LESS_THAN, '2019-12-31')).toBe(false);
        expect(await searchByPeriod(Operator.LESS_THAN, '2020-01-01')).toBe(true);
        expect(await searchByPeriod(Operator.LESS_THAN, '2020-01-02')).toBe(true);
        expect(await searchByPeriod(Operator.LESS_THAN, '2020-01-15')).toBe(true);
        expect(await searchByPeriod(Operator.LESS_THAN, '2020-01-16')).toBe(true);

        expect(await searchByPeriod(Operator.LESS_THAN, '2020-01-01T11:59:59.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.LESS_THAN, '2020-01-01T12:00:00.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.LESS_THAN, '2020-01-15T11:59:59.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.LESS_THAN, '2020-01-15T12:00:00.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.LESS_THAN, '2020-01-15T12:00:01.000Z')).toBe(true);

        expect(await searchByPeriod(Operator.LESS_THAN_OR_EQUALS, '2019-12-31')).toBe(false);
        expect(await searchByPeriod(Operator.LESS_THAN_OR_EQUALS, '2020-01-01')).toBe(true);
        expect(await searchByPeriod(Operator.LESS_THAN_OR_EQUALS, '2020-01-02')).toBe(true);
        expect(await searchByPeriod(Operator.LESS_THAN_OR_EQUALS, '2020-01-15')).toBe(true);
        expect(await searchByPeriod(Operator.LESS_THAN_OR_EQUALS, '2020-01-16')).toBe(true);

        expect(await searchByPeriod(Operator.LESS_THAN_OR_EQUALS, '2020-01-01T11:59:59.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.LESS_THAN_OR_EQUALS, '2020-01-01T12:00:00.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.LESS_THAN_OR_EQUALS, '2020-01-15T11:59:59.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.LESS_THAN_OR_EQUALS, '2020-01-15T12:00:00.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.LESS_THAN_OR_EQUALS, '2020-01-15T12:00:01.000Z')).toBe(true);

        expect(await searchByPeriod(Operator.GREATER_THAN, '2019-12-31')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN, '2020-01-01')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN, '2020-01-02')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN, '2020-01-15')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN, '2020-01-16')).toBe(false);

        expect(await searchByPeriod(Operator.GREATER_THAN, '2020-01-01T11:59:59.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN, '2020-01-01T12:00:00.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN, '2020-01-15T11:59:59.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN, '2020-01-15T12:00:00.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.GREATER_THAN, '2020-01-15T12:00:01.000Z')).toBe(false);

        expect(await searchByPeriod(Operator.GREATER_THAN_OR_EQUALS, '2019-12-31')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN_OR_EQUALS, '2020-01-01')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN_OR_EQUALS, '2020-01-02')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN_OR_EQUALS, '2020-01-15')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN_OR_EQUALS, '2020-01-16')).toBe(false);

        expect(await searchByPeriod(Operator.GREATER_THAN_OR_EQUALS, '2020-01-01T11:59:59.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN_OR_EQUALS, '2020-01-01T12:00:00.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN_OR_EQUALS, '2020-01-15T11:59:59.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN_OR_EQUALS, '2020-01-15T12:00:00.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.GREATER_THAN_OR_EQUALS, '2020-01-15T12:00:01.000Z')).toBe(false);

        expect(await searchByPeriod(Operator.STARTS_AFTER, '2019-12-31')).toBe(true);
        expect(await searchByPeriod(Operator.STARTS_AFTER, '2020-01-01')).toBe(false);
        expect(await searchByPeriod(Operator.STARTS_AFTER, '2020-01-02')).toBe(false);
        expect(await searchByPeriod(Operator.STARTS_AFTER, '2020-01-15')).toBe(false);
        expect(await searchByPeriod(Operator.STARTS_AFTER, '2020-01-16')).toBe(false);

        expect(await searchByPeriod(Operator.STARTS_AFTER, '2020-01-01T11:59:59.000Z')).toBe(true);
        expect(await searchByPeriod(Operator.STARTS_AFTER, '2020-01-01T12:00:00.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.STARTS_AFTER, '2020-01-15T11:59:59.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.STARTS_AFTER, '2020-01-15T12:00:00.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.STARTS_AFTER, '2020-01-15T12:00:01.000Z')).toBe(false);

        expect(await searchByPeriod(Operator.ENDS_BEFORE, '2019-12-31')).toBe(false);
        expect(await searchByPeriod(Operator.ENDS_BEFORE, '2020-01-01')).toBe(false);
        expect(await searchByPeriod(Operator.ENDS_BEFORE, '2020-01-02')).toBe(false);
        expect(await searchByPeriod(Operator.ENDS_BEFORE, '2020-01-15')).toBe(false);
        expect(await searchByPeriod(Operator.ENDS_BEFORE, '2020-01-16')).toBe(true);

        expect(await searchByPeriod(Operator.ENDS_BEFORE, '2020-01-01T11:59:59.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.ENDS_BEFORE, '2020-01-01T12:00:00.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.ENDS_BEFORE, '2020-01-15T11:59:59.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.ENDS_BEFORE, '2020-01-15T12:00:00.000Z')).toBe(false);
        expect(await searchByPeriod(Operator.ENDS_BEFORE, '2020-01-15T12:00:01.000Z')).toBe(true);
      }));

    test('Multiple resource types with _type', async () =>
      withTestContext(async () => {
        const patient = await repo.createResource<Patient>({ resourceType: 'Patient' });
        const obs = await repo.createResource<Observation>({
          resourceType: 'Observation',
          status: 'final',
          code: { text: 'test' },
          subject: createReference(patient),
        });

        const bundle = await repo.search({
          resourceType: 'Patient',
          types: ['Patient', 'Observation'],
          filters: [{ code: '_compartment', operator: Operator.EQUALS, value: getReferenceString(patient) }],
        });
        expect(bundle.entry?.length).toBe(2);
        expect(bundleContains(bundle, patient)).toBeTruthy();
        expect(bundleContains(bundle, obs)).toBeTruthy();
      }));

    test('Binary search not allowed', async () =>
      withTestContext(async () => {
        try {
          await repo.search<Binary>({ resourceType: 'Binary' });
          throw new Error('Expected error');
        } catch (err) {
          const outcome = normalizeOperationOutcome(err);
          expect(outcome.issue?.[0]?.details?.text).toBe('Cannot search on Binary resource type');
        }
      }));

    describe('US Core Search Parameters', () => {
      test('USCoreCareTeamRole', async () =>
        withTestContext(async () => {
          const careTeam = await repo.createResource<CareTeam>({
            resourceType: 'CareTeam',
            participant: [
              {
                member: {
                  reference: 'Practitioner/123',
                },
                role: [
                  {
                    coding: [
                      {
                        system: 'http://snomed.info/sct',
                        code: '102262009',
                        display: 'Chocolate (substance)',
                      },
                    ],
                  },
                ],
              },
            ],
          });

          const bundle1 = await repo.search({
            resourceType: 'CareTeam',
            filters: [{ code: 'role', operator: Operator.EQUALS, value: '102262009' }],
          });
          expect(bundle1.entry?.length).toBe(1);
          expect(bundleContains(bundle1, careTeam)).toBeTruthy();
        }));
      test('USCoreConditionAssertedDate', async () =>
        withTestContext(async () => {
          const resource = await repo.createResource<Condition>({
            resourceType: 'Condition',
            extension: [
              {
                url: 'http://hl7.org/fhir/StructureDefinition/condition-assertedDate',
                // valueDateTime: '2024-03-18T23:04:00.000Z',
                valueDateTime: '2000-03-18',
              },
            ],
            subject: {
              reference: 'Patient/123',
              display: 'Matt Long',
            },
          });

          const oldDate = new Date(1999, 11, 30);
          const bundle1 = await repo.search({
            resourceType: 'Condition',
            // filters: [{ code: 'asserted-date', operator: Operator.GREATER_THAN, value: oldDate.toISOString() }],
            filters: [{ code: 'asserted-date', operator: Operator.STARTS_AFTER, value: oldDate.toISOString() }],
          });
          expect(bundle1.entry?.length).toBe(1);
          expect(bundleContains(bundle1, resource)).toBeTruthy();
        }));
      test('USCoreEncounterDischargeDisposition', async () =>
        withTestContext(async () => {
          const resource = await repo.createResource<Encounter>({
            resourceType: 'Encounter',
            status: 'unknown',
            class: {
              system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
              code: 'IMP',
              display: 'inpatient encounter',
            },
            hospitalization: {
              dischargeDisposition: {
                coding: [
                  {
                    system: 'http://www.nubc.org/patient-discharge',
                    code: '01',
                    display: 'Discharged to Home',
                  },
                ],
              },
            },
          });
          const bundle1 = await repo.search({
            resourceType: 'Encounter',
            filters: [{ code: 'discharge-disposition', operator: Operator.EQUALS, value: '01' }],
          });
          expect(bundle1.entry?.length).toBe(1);
          expect(bundleContains(bundle1, resource)).toBeTruthy();

          const bundle2 = await repo.search({
            resourceType: 'Encounter',
            filters: [{ code: 'discharge-disposition', operator: Operator.EQUALS, value: '55' }],
          });
          expect(bundle2.entry?.length).toBe(0);
        }));
      test('USCoreGoalDescription', async () =>
        withTestContext(async () => {
          const resource = await repo.createResource<Goal>({
            resourceType: 'Goal',
            lifecycleStatus: 'active',
            description: {
              coding: [
                {
                  system: 'http://snomed.info/sct',
                  code: '406156006',
                  display: 'In paid employment',
                },
              ],
              text: 'This text is ignored in search.',
            },
            subject: {
              reference: 'Patient/example',
              display: 'Amy Shaw',
            },
          });
          const bundle1 = await repo.search({
            resourceType: 'Goal',
            filters: [{ code: 'description', operator: Operator.EQUALS, value: '406156006' }],
          });
          expect(bundle1.entry?.length).toBe(1);
          expect(bundleContains(bundle1, resource)).toBeTruthy();
        }));

      test('USCorePatient race, ethnicity, genderIdentity', async () =>
        withTestContext(async () => {
          const resource = await repo.createResource<Patient>({
            resourceType: 'Patient',
            extension: [
              {
                extension: [
                  {
                    url: 'ombCategory',
                    valueCoding: {
                      system: 'urn:oid:2.16.840.1.113883.6.238',
                      code: '2106-3',
                      display: 'White',
                    },
                  },
                  {
                    url: 'ombCategory',
                    valueCoding: {
                      system: 'urn:oid:2.16.840.1.113883.6.238',
                      code: '1002-5',
                      display: 'American Indian or Alaska Native',
                    },
                  },
                  {
                    url: 'ombCategory',
                    valueCoding: {
                      system: 'urn:oid:2.16.840.1.113883.6.238',
                      code: '2028-9',
                      display: 'Asian',
                    },
                  },
                  {
                    url: 'detailed',
                    valueCoding: {
                      system: 'urn:oid:2.16.840.1.113883.6.238',
                      code: '1586-7',
                      display: 'Shoshone',
                    },
                  },
                  {
                    url: 'detailed',
                    valueCoding: {
                      system: 'urn:oid:2.16.840.1.113883.6.238',
                      code: '2036-2',
                      display: 'Filipino',
                    },
                  },
                  {
                    url: 'text',
                    valueString: 'Mixed',
                  },
                ],
                url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race',
              },
              {
                extension: [
                  {
                    url: 'ombCategory',
                    valueCoding: {
                      system: 'urn:oid:2.16.840.1.113883.6.238',
                      code: '2135-2',
                      display: 'Hispanic or Latino',
                    },
                  },
                  {
                    url: 'detailed',
                    valueCoding: {
                      system: 'urn:oid:2.16.840.1.113883.6.238',
                      code: '2184-0',
                      display: 'Dominican',
                    },
                  },
                  {
                    url: 'detailed',
                    valueCoding: {
                      system: 'urn:oid:2.16.840.1.113883.6.238',
                      code: '2148-5',
                      display: 'Mexican',
                    },
                  },
                  {
                    url: 'text',
                    valueString: 'Hispanic or Latino',
                  },
                ],
                url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity',
              },
              {
                url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-genderIdentity',
                valueCodeableConcept: {
                  coding: [
                    {
                      system: 'http://terminology.hl7.org/CodeSystem/v3-NullFlavor',
                      code: 'ASKU',
                      display: 'asked but unknown',
                    },
                  ],
                  text: 'asked but unknown',
                },
              },
            ],
          });

          // race
          const bundle1 = await repo.search({
            resourceType: 'Patient',
            // ombCategory
            filters: [{ code: 'race', operator: Operator.EQUALS, value: '1002-5' }],
          });
          expect(bundle1.entry?.length).toBe(1);
          expect(bundleContains(bundle1, resource)).toBeTruthy();

          const bundle2 = await repo.search({
            resourceType: 'Patient',
            // detailed
            filters: [{ code: 'race', operator: Operator.EQUALS, value: '1586-7' }],
          });
          expect(bundle2.entry?.length).toBe(1);
          expect(bundleContains(bundle2, resource)).toBeTruthy();

          // ethnicity
          const bundle3 = await repo.search({
            resourceType: 'Patient',
            // ombCategory
            filters: [{ code: 'ethnicity', operator: Operator.EQUALS, value: '2135-2' }],
          });
          expect(bundle3.entry?.length).toBe(1);
          expect(bundleContains(bundle3, resource)).toBeTruthy();

          const bundle4 = await repo.search({
            resourceType: 'Patient',
            // detailed
            filters: [{ code: 'ethnicity', operator: Operator.EQUALS, value: '2184-0' }],
          });
          expect(bundle4.entry?.length).toBe(1);
          expect(bundleContains(bundle4, resource)).toBeTruthy();

          // genderIdentity
          const bundle5 = await repo.search({
            resourceType: 'Patient',
            filters: [{ code: 'gender-identity', operator: Operator.EQUALS, value: 'ASKU' }],
          });
          expect(bundle5.entry?.length).toBe(1);
          expect(bundleContains(bundle5, resource)).toBeTruthy();
        }));
    });

    test('Reference search patterns', async () =>
      withTestContext(async () => {
        const uuid = randomUUID();
        const patient1 = await repo.createResource<Patient>({ resourceType: 'Patient', identifier: [{ value: uuid }] });
        const patient2 = await repo.createResource<Patient>({
          resourceType: 'Patient',
          identifier: [{ value: uuid }],
          link: [{ type: 'refer', other: createReference(patient1) }],
        });

        const refStr = getReferenceString(patient1);

        const basicEqualsResult = await repo.search(parseSearchRequest(`Patient?identifier=${uuid}&link=${refStr}`));
        expect(basicEqualsResult.entry).toHaveLength(1);
        expect(basicEqualsResult.entry?.[0]?.resource?.id).toEqual(patient2.id);

        const notEqualsResult = await repo.search(parseSearchRequest(`Patient?identifier=${uuid}&link:not=${refStr}`));
        expect(notEqualsResult.entry).toHaveLength(1);
        expect(notEqualsResult.entry?.[0]?.resource?.id).toEqual(patient1.id);

        const filterEqualsResult = await repo.search(
          parseSearchRequest(`Patient?_filter=identifier eq "${uuid}" and link re "${refStr}"`)
        );
        expect(filterEqualsResult.entry).toHaveLength(1);
        expect(filterEqualsResult.entry?.[0]?.resource?.id).toEqual(patient2.id);

        const filterNotEqualsResult = await repo.search(
          parseSearchRequest(`Patient?_filter=identifier eq "${uuid}" and link ne "${refStr}"`)
        );
        expect(filterNotEqualsResult.entry).toHaveLength(1);
        expect(filterNotEqualsResult.entry?.[0]?.resource?.id).toEqual(patient1.id);
      }));
    describe('searchByReference', () => {
      async function createPatients(repo: Repository, count: number): Promise<Patient[]> {
        const patients = [];
        for (let i = 0; i < count; i++) {
          patients.push(await repo.createResource<Patient>({ resourceType: 'Patient' }));
        }
        return patients;
      }

      async function createObservations(
        repo: Repository,
        count: number,
        {
          subject,
          hasMember,
        }: {
          subject?: Patient;
          hasMember?: Observation[];
        }
      ): Promise<Observation[]> {
        const resources = [];
        for (let i = 0; i < count; i++) {
          resources.push(
            await repo.createResource<Observation>({
              resourceType: 'Observation',
              subject: subject ? createReference(subject) : undefined,
              hasMember: hasMember ? hasMember.map((o) => createReference(o)) : undefined,
              status: 'final',
              code: { text: 'code CodeableConcept.text' },
              valueString: i.toString(),
            })
          );
        }
        return resources;
      }

      async function createServiceRequests(
        repo: Repository,
        count: number,
        patient: Patient
      ): Promise<ServiceRequest[]> {
        const resources = [];
        for (let i = 0; i < count; i++) {
          resources.push(
            await repo.createResource<ServiceRequest>({
              resourceType: 'ServiceRequest',
              subject: createReference(patient),
              status: 'active',
              intent: 'plan',
            })
          );
        }
        return resources;
      }

      function expectResultsContents<Parent extends Resource, Child extends Resource>(
        parents: Parent[],
        childrenByParent: Child[][],
        count: number,
        results: Record<string, Child[]>
      ): void {
        expect(Object.keys(results)).toHaveLength(parents.length);
        for (const [parent, children] of zip(parents, childrenByParent)) {
          const result = results[getReferenceString(parent)];
          expect(result).toHaveLength(Math.min(children.length, count));
          for (const child of result) {
            expect(children.map((c) => c.id)).toContain(child.id);
          }
        }
      }

      function zip<A, B>(a: A[], b: B[]): [A, B][] {
        return a.map((k, i) => [k, b[i]]);
      }
      test('Basic reference', async () =>
        withTestContext(async () => {
          const patients = await createPatients(repo, 3);
          const patientObservations = [
            await createObservations(repo, 2, { subject: patients[0] }),
            await createObservations(repo, 0, { subject: patients[1] }),
            await createObservations(repo, 4, { subject: patients[2] }),
          ];
          const observation = patientObservations[0][0];
          const count = 3;
          const result = await repo.searchByReference<Observation>(
            { resourceType: 'Observation', count },
            'subject',
            patients.map((p) => getReferenceString(p))
          );

          expectResultsContents(patients, patientObservations, count, result);
          const resultRepoObservation = result[getReferenceString(patients[0])][0];
          expect(resultRepoObservation).toEqual(observation);
          expect(resultRepoObservation.meta?.tag).toBeUndefined();
        }));

      test('Array reference column', async () =>
        withTestContext(async () => {
          const parentObservations = await createObservations(repo, 3, {});
          const childObservations = [
            await createObservations(repo, 2, { hasMember: [parentObservations[0]] }),
            await createObservations(repo, 0, { hasMember: [parentObservations[1]] }),
            await createObservations(repo, 4, { hasMember: [parentObservations[2]] }),
          ];
          const observation = childObservations[0][0];
          const count = 3;
          const result = await repo.searchByReference<Observation>(
            { resourceType: 'Observation', count },
            'has-member',
            parentObservations.map((o) => getReferenceString(o))
          );

          expectResultsContents(parentObservations, childObservations, count, result);
          const resultRepoObservation = result[getReferenceString(parentObservations[0])][0];
          expect(resultRepoObservation).toEqual(observation);
          expect(resultRepoObservation.meta?.tag).toBeUndefined();
        }));

      test('Invalid reference field', async () =>
        withTestContext(async () => {
          // 'code' is not a reference search parameter
          await expect(() =>
            repo.searchByReference<Observation>({ resourceType: 'Observation', count: 1 }, 'code', [])
          ).rejects.toThrow('Invalid reference search parameter');
        }));

      test('Reference with sort', async () =>
        withTestContext(async () => {
          const patients = await createPatients(repo, 2);
          const patientObservations = [
            await createObservations(repo, 3, { subject: patients[0] }),
            await createObservations(repo, 2, { subject: patients[1] }),
          ];
          const count = 3;

          // descending
          const resultDesc = await repo.searchByReference<Observation>(
            { resourceType: 'Observation', count, sortRules: [{ code: 'value-string', descending: true }] },
            'subject',
            patients.map((p) => getReferenceString(p))
          );

          expectResultsContents(patients, patientObservations, count, resultDesc);
          expect(resultDesc[getReferenceString(patients[0])].map((o) => o.valueString)).toEqual(['2', '1', '0']);
          expect(resultDesc[getReferenceString(patients[1])].map((o) => o.valueString)).toEqual(['1', '0']);

          // ascending
          const resultAsc = await repo.searchByReference<Observation>(
            { resourceType: 'Observation', count, sortRules: [{ code: 'value-string', descending: false }] },
            'subject',
            patients.map((p) => getReferenceString(p))
          );
          expectResultsContents(patients, patientObservations, count, resultAsc);
          expect(resultAsc[getReferenceString(patients[0])].map((o) => o.valueString)).toEqual(['0', '1', '2']);
          expect(resultAsc[getReferenceString(patients[1])].map((o) => o.valueString)).toEqual(['0', '1']);
        }));

      test('narrowed fields', async () =>
        withTestContext(async () => {
          const patients = await createPatients(repo, 1);
          const patientObservations = [await createObservations(repo, 1, { subject: patients[0] })];

          const count = 1;
          const result = await repo.searchByReference<Observation>(
            { resourceType: 'Observation', count, fields: ['status'] },
            'subject',
            patients.map((p) => getReferenceString(p))
          );

          expectResultsContents(patients, patientObservations, count, result);
          const observation = patientObservations[0][0];
          const resultObservation = result[getReferenceString(patients[0])][0];
          expect({ ...observation, meta: undefined }).toEqual({
            resourceType: 'Observation',
            id: observation.id,
            status: observation.status,
            code: observation.code,
            method: observation.method,
            subject: expect.objectContaining({ reference: getReferenceString(patients[0]) }),
            valueString: observation.valueString,
          });

          expect(resultObservation).toEqual({
            resourceType: 'Observation',
            id: observation.id,
            meta: expect.objectContaining({
              tag: [SUBSET_TAG],
            }),
            status: observation.status,
            code: observation.code, // code is a mandatory field so is included even though not specified in fields
          });
        }));

      test('Multiple types', async () =>
        withTestContext(async () => {
          const patients = await createPatients(repo, 3);
          const patientObservations = [
            await createObservations(repo, 0, { subject: patients[0] }),
            await createObservations(repo, 1, { subject: patients[1] }),
            await createObservations(repo, 3, { subject: patients[2] }),
          ];

          const patientServiceRequests = [
            await createServiceRequests(repo, 3, patients[0]),
            await createServiceRequests(repo, 1, patients[1]),
            await createServiceRequests(repo, 0, patients[2]),
          ];

          const count = 2;
          const result = await repo.searchByReference(
            { resourceType: 'Observation', count, types: ['Observation', 'ServiceRequest'], fields: ['subject'] },
            'subject',
            patients.map((p) => getReferenceString(p))
          );

          const childrenByParent = [];
          for (let i = 0; i < patients.length; i++) {
            childrenByParent.push([...patientObservations[i], ...patientServiceRequests[i]]);
          }
          expectResultsContents(patients, childrenByParent, count, result);

          // First patient has only ServiceRequests
          expect(result[getReferenceString(patients[0])].map((r) => r.resourceType)).toEqual([
            'ServiceRequest',
            'ServiceRequest',
          ]);

          // Second patient has one ServiceRequest and one Observation
          expect(
            result[getReferenceString(patients[1])].map((r) => r.resourceType).sort((a, b) => a.localeCompare(b))
          ).toEqual(['Observation', 'ServiceRequest']);

          // Third patient has only Observations
          expect(result[getReferenceString(patients[2])].map((r) => r.resourceType)).toEqual([
            'Observation',
            'Observation',
          ]);
        }));

      test('Error on cursor and offset', () =>
        withTestContext(async () => {
          try {
            await repo.search({ resourceType: 'Patient', offset: 10, cursor: 'foo' });
            fail('Expected error');
          } catch (err) {
            expect(normalizeErrorString(err)).toBe('Cannot use both offset and cursor');
          }
        }));

      test('Cursor pagination', () =>
        withTestContext(async () => {
          const tasks: Task[] = [];
          for (let i = 0; i < 50; i++) {
            const task = await repo.createResource<Task>({
              resourceType: 'Task',
              status: 'accepted',
              intent: 'order',
              code: { text: 'cursor_test' },
            });
            tasks.push(task);
          }

          let url = 'Task?code=cursor_test&_sort=_lastUpdated';
          let count = 0;
          while (url) {
            const bundle = await repo.search(parseSearchRequest(url));
            count += bundle.entry?.length ?? 0;

            const link = bundle.link?.find((l) => l.relation === 'next')?.url;
            if (link) {
              expect(link.includes('_cursor')).toBe(true);
              url = link;
            } else {
              url = '';
            }
          }
          expect(count).toBe(50);
        }));
    });
  });

  describe('systemRepo', () => {
    const systemRepo = getSystemRepo();

    beforeAll(async () => {
      const config = await loadTestConfig();
      await initAppServices(config);
    });

    afterAll(async () => {
      await shutdownApp();
    });

    test('Filter by _project', () =>
      withTestContext(async () => {
        const project1 = (await systemRepo.createResource<Project>({ resourceType: 'Project' })).id as string;
        const project2 = (await systemRepo.createResource<Project>({ resourceType: 'Project' })).id as string;

        const patient1 = await systemRepo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice1'], family: 'Smith1' }],
          meta: {
            project: project1,
          },
        });
        expect(patient1).toBeDefined();

        const patient2 = await systemRepo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice2'], family: 'Smith2' }],
          meta: {
            project: project2,
          },
        });
        expect(patient2).toBeDefined();

        const bundle = await systemRepo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: '_project',
              operator: Operator.EQUALS,
              value: project1,
            },
          ],
        });
        expect(bundle.entry?.length).toEqual(1);
        expect(bundleContains(bundle as Bundle, patient1 as Patient)).toBeDefined();
        expect(bundleContains(bundle as Bundle, patient2 as Patient)).toBeUndefined();
      }));

    test('Filter by _lastUpdated', () =>
      withTestContext(async () => {
        // Create 2 patients
        // One with a _lastUpdated of 1 second ago
        // One with a _lastUpdated of 2 seconds ago
        const family = randomUUID();
        const now = new Date();
        const nowMinus1Second = new Date(now.getTime() - 1000);
        const nowMinus2Seconds = new Date(now.getTime() - 2000);
        const nowMinus3Seconds = new Date(now.getTime() - 3000);

        const patient1 = await systemRepo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice'], family }],
          meta: {
            lastUpdated: nowMinus1Second.toISOString(),
          },
        });
        expect(patient1).toBeDefined();

        const patient2 = await systemRepo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice'], family }],
          meta: {
            lastUpdated: nowMinus2Seconds.toISOString(),
          },
        });
        expect(patient2).toBeDefined();

        // Greater than (newer than) 2 seconds ago should only return patient 1
        const searchResult1 = await systemRepo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'name',
              operator: Operator.EQUALS,
              value: family,
            },
            {
              code: '_lastUpdated',
              operator: Operator.GREATER_THAN,
              value: nowMinus2Seconds.toISOString(),
            },
          ],
        });

        expect(bundleContains(searchResult1 as Bundle, patient1 as Patient)).toBeDefined();
        expect(bundleContains(searchResult1 as Bundle, patient2 as Patient)).toBeUndefined();

        // Greater than (newer than) or equal to 2 seconds ago should return both patients
        const searchResult2 = await systemRepo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'name',
              operator: Operator.EQUALS,
              value: family,
            },
            {
              code: '_lastUpdated',
              operator: Operator.GREATER_THAN_OR_EQUALS,
              value: nowMinus2Seconds.toISOString(),
            },
          ],
        });

        expect(bundleContains(searchResult2 as Bundle, patient1 as Patient)).toBeDefined();
        expect(bundleContains(searchResult2 as Bundle, patient2 as Patient)).toBeDefined();

        // Less than (older than) to 1 seconds ago should only return patient 2
        const searchResult3 = await systemRepo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'name',
              operator: Operator.EQUALS,
              value: family,
            },
            {
              code: '_lastUpdated',
              operator: Operator.GREATER_THAN,
              value: nowMinus3Seconds.toISOString(),
            },
            {
              code: '_lastUpdated',
              operator: Operator.LESS_THAN,
              value: nowMinus1Second.toISOString(),
            },
          ],
        });

        expect(bundleContains(searchResult3 as Bundle, patient1 as Patient)).toBeUndefined();
        expect(bundleContains(searchResult3 as Bundle, patient2 as Patient)).toBeDefined();

        // Less than (older than) or equal to 1 seconds ago should return both patients
        const searchResult4 = await systemRepo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: 'name',
              operator: Operator.EQUALS,
              value: family,
            },
            {
              code: '_lastUpdated',
              operator: Operator.GREATER_THAN,
              value: nowMinus3Seconds.toISOString(),
            },
            {
              code: '_lastUpdated',
              operator: Operator.LESS_THAN_OR_EQUALS,
              value: nowMinus1Second.toISOString(),
            },
          ],
        });

        expect(bundleContains(searchResult4 as Bundle, patient1 as Patient)).toBeDefined();
        expect(bundleContains(searchResult4 as Bundle, patient2 as Patient)).toBeDefined();
      }));

    test('Sort by _lastUpdated', () =>
      withTestContext(async () => {
        const project = (await systemRepo.createResource<Project>({ resourceType: 'Project' })).id as string;

        const patient1 = await systemRepo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice1'], family: 'Smith1' }],
          meta: {
            lastUpdated: '2020-01-01T00:00:00.000Z',
            project,
          },
        });
        expect(patient1).toBeDefined();

        const patient2 = await systemRepo.createResource<Patient>({
          resourceType: 'Patient',
          name: [{ given: ['Alice2'], family: 'Smith2' }],
          meta: {
            lastUpdated: '2020-01-02T00:00:00.000Z',
            project,
          },
        });
        expect(patient2).toBeDefined();

        const bundle3 = await systemRepo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: '_project',
              operator: Operator.EQUALS,
              value: project,
            },
          ],
          sortRules: [
            {
              code: '_lastUpdated',
              descending: false,
            },
          ],
        });
        expect(bundle3.entry?.length).toEqual(2);
        expect(bundle3.entry?.[0]?.resource?.id).toEqual(patient1.id);
        expect(bundle3.entry?.[1]?.resource?.id).toEqual(patient2.id);

        const bundle4 = await systemRepo.search({
          resourceType: 'Patient',
          filters: [
            {
              code: '_project',
              operator: Operator.EQUALS,
              value: project,
            },
          ],
          sortRules: [
            {
              code: '_lastUpdated',
              descending: true,
            },
          ],
        });
        expect(bundle4.entry?.length).toEqual(2);
        expect(bundle4.entry?.[0]?.resource?.id).toEqual(patient2.id);
        expect(bundle4.entry?.[1]?.resource?.id).toEqual(patient1.id);
      }));
  });
});
