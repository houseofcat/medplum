/*
 * This is a generated file
 * Do not edit manually.
 */

import { Extension } from './Extension';
import { Meta } from './Meta';
import { Narrative } from './Narrative';
import { Resource } from './Resource';
import { ResourceType } from './ResourceType';

/**
 * User specific configuration for the Medplum application.
 */
export interface BulkDataExport {

  /**
   * This is a BulkDataExport resource
   */
  readonly resourceType: 'BulkDataExport';

  /**
   * The logical id of the resource, as used in the URL for the resource.
   * Once assigned, this value never changes.
   */
  id?: string;

  /**
   * The metadata about the resource. This is content that is maintained by
   * the infrastructure. Changes to the content might not always be
   * associated with version changes to the resource.
   */
  meta?: Meta;

  /**
   * A reference to a set of rules that were followed when the resource was
   * constructed, and which must be understood when processing the content.
   * Often, this is a reference to an implementation guide that defines the
   * special rules along with other profiles etc.
   */
  implicitRules?: string;

  /**
   * The base language in which the resource is written.
   */
  language?: string;

  /**
   * A human-readable narrative that contains a summary of the resource and
   * can be used to represent the content of the resource to a human. The
   * narrative need not encode all the structured data, but is required to
   * contain sufficient detail to make it &quot;clinically safe&quot; for a human to
   * just read the narrative. Resource definitions may define what content
   * should be represented in the narrative to ensure clinical safety.
   */
  text?: Narrative;

  /**
   * These resources do not have an independent existence apart from the
   * resource that contains them - they cannot be identified independently,
   * and nor can they have their own independent transaction scope.
   */
  contained?: Resource[];

  /**
   * May be used to represent additional information that is not part of
   * the basic definition of the resource. To make the use of extensions
   * safe and manageable, there is a strict set of governance  applied to
   * the definition and use of extensions. Though any implementer can
   * define an extension, there is a set of requirements that SHALL be met
   * as part of the definition of the extension.
   */
  extension?: Extension[];

  /**
   * May be used to represent additional information that is not part of
   * the basic definition of the resource and that modifies the
   * understanding of the element that contains it and/or the understanding
   * of the containing element's descendants. Usually modifier elements
   * provide negation or qualification. To make the use of extensions safe
   * and manageable, there is a strict set of governance applied to the
   * definition and use of extensions. Though any implementer is allowed to
   * define an extension, there is a set of requirements that SHALL be met
   * as part of the definition of the extension. Applications processing a
   * resource are required to check for modifier extensions.
   *
   * Modifier extensions SHALL NOT change the meaning of any elements on
   * Resource or DomainResource (including cannot change the meaning of
   * modifierExtension itself).
   */
  modifierExtension?: Extension[];

  /**
   * The status of the request.
   */
  status: 'accepted' | 'active' | 'completed' | 'error' | 'cancelled';

  /**
   * Indicates the server's time when the query is requested.
   */
  requestTime: string;

  /**
   * Indicates the server's time when the query is run. The response SHOULD
   * NOT include any resources modified after this instant, and SHALL
   * include any matching resources modified up to and including this
   * instant.
   */
  transactionTime?: string;

  /**
   * The full URL of the original Bulk Data kick-off request. In the case
   * of a POST request, this URL will not include the request parameters.
   */
  request: string;

  /**
   * Indicates whether downloading the generated files requires the same
   * authorization mechanism as the $export operation itself.
   */
  requiresAccessToken?: boolean;

  /**
   * An array of file items with one entry for each generated file. If no
   * resources are returned from the kick-off request, the server SHOULD
   * return an empty array.
   */
  output?: BulkDataExportOutput[];

  /**
   * An array of deleted file items following the same structure as the
   * output array.
   */
  deleted?: BulkDataExportDeleted[];

  /**
   * Array of message file items following the same structure as the output
   * array.
   */
  error?: BulkDataExportError[];
}

/**
 * An array of deleted file items following the same structure as the
 * output array.
 */
export interface BulkDataExportDeleted {

  /**
   * The FHIR resource type that is contained in the file.
   */
  type: ResourceType;

  /**
   * The absolute path to the file. The format of the file SHOULD reflect
   * that requested in the _outputFormat parameter of the initial kick-off
   * request.
   */
  url: string;
}

/**
 * Array of message file items following the same structure as the output
 * array.
 */
export interface BulkDataExportError {

  /**
   * The FHIR resource type that is contained in the file.
   */
  type: ResourceType;

  /**
   * The absolute path to the file. The format of the file SHOULD reflect
   * that requested in the _outputFormat parameter of the initial kick-off
   * request.
   */
  url: string;
}

/**
 * An array of file items with one entry for each generated file. If no
 * resources are returned from the kick-off request, the server SHOULD
 * return an empty array.
 */
export interface BulkDataExportOutput {

  /**
   * The FHIR resource type that is contained in the file.
   */
  type: ResourceType;

  /**
   * The absolute path to the file. The format of the file SHOULD reflect
   * that requested in the _outputFormat parameter of the initial kick-off
   * request.
   */
  url: string;
}
