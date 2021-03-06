import PouchDB from 'pouchdb';
import PouchFind from 'pouchdb-find';
import * as ClassValidator from 'class-validator';

PouchDB.plugin(PouchFind);

import CreateIndexResponse = PouchDB.Find.CreateIndexResponse;

const ChanceTool = require('chance');
const chance = new ChanceTool();
const retry = require('async-retry');


export interface IModel {
    _id?: string;
    _rev?: string;
    _deleted?: boolean;
    $timestamp?: number;
    $collectionType?: string; // Holds what type of object this is
}

export enum CollectionState {
    NEW,
    LOADING,
    READY,
}

export enum ClassValidate {
    OFF,
    ON,
    ON_AND_LOG,
    ON_AND_REJECT
}

export class PouchORM {
    static databases: { [key: string]: PouchDB.Database } = {};
    static LOGGING = false;
    static VALIDATE = ClassValidate.OFF;
    static ClassValidator: typeof ClassValidator;
    static PouchDB = PouchDB;

    static getDatabase(dbName: string, opts?: PouchDB.Configuration.DatabaseConfiguration): any {
        if (!PouchORM.databases[dbName]) {
            if (PouchORM.LOGGING) console.log('Creating DB: ', dbName);
            PouchORM.databases[dbName] = new PouchDB(dbName, opts);
        }

        // ensure opts match up with database being returned
        if (opts) {

        }

        return PouchORM.databases[dbName];
    }

    static async clearDatabase(dbName: string) {

        const db = PouchORM.getDatabase(dbName);

        const result = await db.allDocs();
        return Promise.all(result.rows.map(function (row) {
            return db.remove(row.id, row.value.rev);
        }));
    }

    static getClassValidator() {
        let classValidator: typeof ClassValidator;

        try {
            classValidator = require('class-validator');
        } catch (error) {
            console.log('Error initializing validator: ', error);
        }

        return PouchORM.ClassValidator = classValidator;
    }
}

export function UpsertHelper(item: any) {
    return {
        merge: (existing: any) => ({...existing, ...item, _rev: existing._rev }),
        replace: (existing: any) => ({ ...item, _rev: existing._rev })
    };
}

export abstract class PouchModel<T> implements IModel {
    constructor (item: T) {
        Object.assign(this, item);
    }

    _id?: string;
    _rev?: string;
    _deleted?: boolean;
    $timestamp?: number;
    $collectionType?: string;
}

export abstract class PouchCollection<T extends IModel> {


    _state = CollectionState.NEW;
    db: PouchDB.Database;
    collectionTypeName: string;
    validate: ClassValidate;

    private indexes: { fields: (keyof T)[]; name?: string }[] = [];


    constructor(dbname: string, opts?: PouchDB.Configuration.DatabaseConfiguration, validate: ClassValidate = ClassValidate.OFF) {
        this.db = PouchORM.getDatabase(dbname, opts);
        this.collectionTypeName = this.constructor.name;
        this.validate = validate;
        if (PouchORM.LOGGING) console.log('initializing collection :', this.collectionTypeName);
    }

    async checkInit(): Promise<void> {
        if (this._state === CollectionState.READY) return;
        if (this._state === CollectionState.NEW) return this.runInit();
        if (this._state === CollectionState.LOADING) {

            // The most probable way we arrive here is if a previous attemot to init collection failed.
            // We should wait for init's retries. Honestly this is an extreme case...
            return retry(async bail => {
                // if anything throws, we retry
                console.log(`waiting for initialization of ${this.constructor.name}...`);
                if (this._state === CollectionState.READY)
                    throw new Error(`PouchCollection: Cannot perform operations on uninitialized collection ${this.constructor.name}`);

            }, {
                retries: 3,
                minTimeout: 2000
            });
        }
    }

    /**
     * Can be overriden by sub classes to do things before collection initialization.
     * E.g define indexes using this.addIndex etc when initializing the collection
     */
    async beforeInit(): Promise<void> {

    }

    /**
     * Can be overriden by sub classes to perform actions after initialization.
     */
    async afterInit(): Promise<void> {

    }

    /**
     * Does the actual work to initialize a collection.
     */
    private async runInit(): Promise<void> {
        this._state = CollectionState.LOADING;

        await this.beforeInit();

        // await retry(async bail => {
        //     // if anything throws, we retry
        //     console.log(`Initializing ${this.constructor.name}...`);
        //
        //
        //
        // }, {
        //     retries: 3
        // });

        await this.addIndex([]); // for only collection type
        await this.addIndex(['$timestamp']); // for collectionType and timestamp

        await this.afterInit();
        this._state = CollectionState.READY;
    }

    async addIndex(fields: (keyof T)[], name?: string): Promise<CreateIndexResponse<{}>> {

        // append $collectionType to fields
        fields.unshift('$collectionType');
        this.indexes.push({fields, name});

        return this.db.createIndex({
            index: {
                fields: fields as string[],
                name
            },
        });
    }

    async find(
        selector?: Partial<T> | { [key: string]: any },
        opts?: { sort?: string[], limit?: number },
    ): Promise<T[]> {
        const sel = selector || {};
        await this.checkInit();
        sel.$collectionType = this.collectionTypeName;

        const {docs} = await this.db.find({
            selector: sel,
            sort: opts?.sort || undefined,// FIXME: ensure this works
            limit: opts?.limit
        });

        return docs as T[];
    }

    async findOne(selector: Partial<T> | { [key: string]: any }): Promise<T> {
        const matches = await this.find(selector, {limit: 1});
        return matches.length > 0 ? matches[0] : null;
    }

    async findOrFail(
        selector?: Partial<T> | { [key: string]: any },
        opts?: { sort?: string[], limit?: number },
    ): Promise<T[]> {
        const docs = await this.find(selector, opts);

        if (!Array.isArray(docs) || docs.length === 0) {
            throw new Error(`${this.constructor.name} of criteria ${selector} does not exist`);
        }

        return docs;
    }

    async findOneOrFail(selector: Partial<T> | { [key: string]: any }): Promise<T> {
        const matches = await this.findOrFail(selector, {limit: 1});
        return matches[0];
    }

    async findById(_id: string): Promise<T> {
        if (!_id) return null;
        return this.findOne({_id} as Partial<T>);
    }

    async findByIdOrFail(_id: string): Promise<T> {
        return this.findOneOrFail({_id} as Partial<T>);
    }

    async removeById(id: string): Promise<void> {

        const doc: T = await this.findById(id);
        if (PouchORM.LOGGING) console.log(this.constructor.name + ' PouchDB removeById', doc);
        if (doc) await this.db.remove(doc._id, doc._rev);
    }

    async remove(item: T): Promise<void> {

        if (PouchORM.LOGGING) console.log(this.constructor.name + ' PouchDB remove', item);
        if (item) await this.db.remove(item._id, item._rev);
    }

    private setMetaFields = (item: T) => {
        if (!item._id) {
            item._id = chance.guid();
        }

        item.$timestamp = Date.now();
        item.$collectionType = this.collectionTypeName;

        return item;
    };
    private markDeleted = (item: T) => {
        item._deleted = true;

        return item;
    };

    async upsert(item: T, deltaFunc?: (existing: T) => T): Promise<T> {
        const existing = await this.findById(item._id);
        const validate = this.validate !== ClassValidate.OFF
            ? this.validate
            : PouchORM.VALIDATE !== ClassValidate.OFF
                ? PouchORM.VALIDATE
                : ClassValidate.OFF;

        if (existing) {
            if (!deltaFunc) deltaFunc = UpsertHelper(item).replace;

            item = deltaFunc(existing);

            if (PouchORM.LOGGING) console.log(this.constructor.name + ' PouchDB updating', item);
        } else {
            if (PouchORM.LOGGING) console.log(this.constructor.name + ' PouchDB create', item);
        }

        if (validate !== ClassValidate.OFF && PouchORM.ClassValidator === undefined) PouchORM.getClassValidator();

        switch (validate) {
            case ClassValidate.ON:
                if (PouchORM.LOGGING)
                    console.log('Valid ' + item.constructor.name + ':', await PouchORM.ClassValidator.validate(item));
                break;
            case ClassValidate.ON_AND_LOG:
                console.log('Valid ' + item.constructor.name + ':', await PouchORM.ClassValidator.validate(item));
                break;
            case ClassValidate.ON_AND_REJECT:
                await PouchORM.ClassValidator.validateOrReject(item);
                break;
        }

        this.setMetaFields(item);

        if (PouchORM.LOGGING) console.log(this.constructor.name + ' PouchDB beforeSave', item);

        await this.db.put(item, { force: true });

        const doc = await this.findById(item._id);
        if (PouchORM.LOGGING) console.log(this.constructor.name + ' PouchDB afterSave', doc);
        return doc;
    }

    async bulkUpsert(items: T[]): Promise<Array<PouchDB.Core.Response | PouchDB.Core.Error>> {

        const result = await this.db.bulkDocs(items.map(this.setMetaFields));
        return result;
    }

    async bulkRemove(items: T[]): Promise<Array<PouchDB.Core.Response | PouchDB.Core.Error>> {

        const result = await this.db.bulkDocs(items.map(this.markDeleted));
        return result;
    }

}
